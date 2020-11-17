import got from '../utils/got';
import fastQueue from 'fastq';
import hashFeed from './hash-feed';
import { RecurrenceRule, scheduleJob } from 'node-schedule';
import logger, { logHttpError } from './logger';
import { findFeed } from './feed';
import { config } from '../config';
import { Feed, FeedItem } from '../types/feed';
import { Optional, Option, isNone, none, isSome, Some } from '../types/option';
import { parseString } from '../parser/parse';
import {
    getAllFeeds,
    updateHashList,
    failAttempt,
    getFeedByUrl,
    updateFeed,
    handleRedirect,
    updateFeedUrl
} from '../proxies/rss-feed';
import {
    Messager,
    SuccessMessage,
    ErrorMaxTimeMessage,
    ChangeFeedUrlMessage
} from '../types/message';
const { notify_error_count, item_num, concurrency, fetch_gap } = config;

async function handleErr(e: Messager, feed: Feed): Promise<void> {
    logger.info(`${feed.feed_title} ${feed.url}`, 'ERROR_MANY_TIME');
    const message: ErrorMaxTimeMessage = {
        success: false,
        message: 'MAX_TIME',
        err: { message: e.message },
        feed
    };
    process.send(message);
    const { origin } = new URL(feed.url);
    const res = await got(origin);
    const newUrl = await findFeed(res.body, origin);
    delete res.body;
    delete res.rawBody;
    if (newUrl.length > 0) {
        updateFeedUrl(feed.url, newUrl[0]);
        const message: ChangeFeedUrlMessage = {
            success: false,
            message: 'CHANGE',
            new_feed: newUrl,
            err: { message: e.message },
            feed: feed
        };
        process.send(message);
    }
}

async function fetch(feedModal: Feed): Promise<Option<any[]>> {
    const feedUrl = feedModal.url;
    try {
        logger.debug(`fetching ${feedUrl}`);
        const res = await got.get(encodeURI(feedUrl));
        if (encodeURI(feedUrl) !== res.url && Object.is(res.statusCode, 301)) {
            await handleRedirect(feedUrl, decodeURI(res.url));
        }
        const feed = await parseString(res.body);

        const items = feed.items.slice(0, item_num);
        feedModal.error_count = 0;
        feedModal.feed_title = feed.title;
        await updateFeed(feedModal);
        return Optional(
            items.map((item) => {
                const { link, title, id } = item;
                return { link, title, id };
            })
        );
    } catch (e) {
        logHttpError(feedUrl, e);
        await failAttempt(feedUrl);
        const feed = await getFeedByUrl(feedUrl);
        if (isSome(feed)) {
            const round_time = notify_error_count * 10;
            const round_happen =
                feed.value.error_count % round_time === 0 &&
                feed.value.error_count > round_time;
            if (feed.value.error_count === notify_error_count || round_happen) {
                handleErr(e, feed.value);
            }
        }
    }
    return none;
}

const fetchAll = async (): Promise<void> => {
    process.send && process.send('start fetching');
    const allFeeds = await getAllFeeds();
    const queue = fastQueue(async (eachFeed: Feed, cb) => {
        const oldHashList = JSON.parse(eachFeed.recent_hash_list);
        let fetchedItems: Option<FeedItem[]>, sendItems: FeedItem[];
        try {
            fetchedItems = await fetch(eachFeed);
            if (isNone(fetchedItems)) {
                cb(new Error('fetch failed ' + eachFeed.url));
            } else {
                const newHashList: string[] = await Promise.all(
                    fetchedItems.value.map(
                        async (item: FeedItem): Promise<string> => {
                            return await hashFeed(item);
                        }
                    )
                );
                const newItems = await Promise.all(
                    fetchedItems.value.map(
                        async (item: FeedItem): Promise<Option<FeedItem>> => {
                            const hash = await hashFeed(item);
                            if (oldHashList.indexOf(hash) === -1)
                                return Optional(item);
                            else return none;
                        }
                    )
                );
                sendItems = newItems
                    .filter(isSome)
                    .map((some: Some<FeedItem>) => some.value);
                if (sendItems.length > 0) {
                    await updateHashList(eachFeed.feed_id, newHashList);
                }
                cb(null, sendItems);
            }
        } catch (e) {
            cb(e, undefined);
        }
    }, concurrency);
    allFeeds.forEach((feed) =>
        queue.push(feed, (err, sendItems) => {
            if (err) {
                logger.error(err);
            } else {
                if (sendItems) {
                    process.send &&
                        sendItems &&
                        process.send({
                            success: true,
                            sendItems,
                            feed: feed
                        } as SuccessMessage);
                }
            }
        })
    );
};

function run() {
    try {
        fetchAll().then(() => logger.info('fetch a round'));
    } catch (e) {
        logger.error(
            `[Catch in all ${e.name}] ${e.url} ${e.statusCode} ${e.statusMessage}`
        );
        logger.debug(e);
    }
}
function gc() {
    const beforeGC = process.memoryUsage();
    const gcStartTime = process.hrtime.bigint();
    global.gc();
    const afterGC = process.memoryUsage();
    const gcEndTime = process.hrtime.bigint();
    logger.info(
        `heapUsedBefore: ${beforeGC.heapUsed} heapUsedAfter: ${
            afterGC.heapUsed
        } rssBefore: ${beforeGC.rss} rssAfater: ${afterGC.rss} costed ${
            gcEndTime - gcStartTime
        }`
    );
    setTimeout(gc, 3 * 60 * 1000);
}
gc();
run();
const rule = new RecurrenceRule();
const unit = fetch_gap.substring(fetch_gap.length - 1);
const gapNum = parseInt(fetch_gap.substring(0, fetch_gap.length - 1));
const time_gaps = [];
switch (unit) {
    case 'h':
        for (let i = 0; i < 24; i = i + gapNum) {
            time_gaps.push(i);
        }
        rule.hour = time_gaps;
        logger.info('fetch every ' + gapNum + ' hour(s)');
        break;
    case 'm':
    default:
        for (let i = 0; i < 60; i = i + gapNum) time_gaps.push(i);
        rule.minute = time_gaps;
        logger.info('fetch every ' + gapNum + ' minutes');
        break;
}

scheduleJob(rule, run);
