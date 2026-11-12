type MockedFetchResponse = {
    ok: boolean;
    status: number;
    statusText?: string;
    textConverted?: jest.Mock<Promise<string>, []>;
};

const requestMock = jest.fn();
const defaultsMock = jest.fn(() => requestMock);

function loadGotModule() {
    jest.resetModules();
    requestMock.mockReset();
    defaultsMock.mockClear();

    jest.doMock('make-fetch-happen', () => ({
        __esModule: true,
        default: {
            defaults: defaultsMock
        }
    }));
    jest.doMock('../source/config', () => ({
        config: {
            UA: 'NodeRSSBot Test UA',
            resp_timeout: 12,
            PKG_ROOT: '/tmp/node-rssbot-test'
        }
    }));
    jest.doMock('../source/utils/agent', () => ({
        proxyUrl: 'http://proxy.example:8080'
    }));

    return require('../source/utils/got') as typeof import('../source/utils/got');
}

describe('got', () => {
    test('configures make-fetch-happen defaults', () => {
        loadGotModule();

        expect(defaultsMock).toHaveBeenCalledWith({
            headers: {
                'user-agent': 'NodeRSSBot Test UA',
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8 '
            },
            timeout: 12 * 1000,
            proxy: 'http://proxy.example:8080',
            retry: {
                randomize: true,
                maxTimeout: 30 * 1000,
                retries: 5
            },
            cachePath: '/tmp/node-rssbot-test/data/fetch-cache'
        });
    });

    test('returns successful responses unchanged', async () => {
        const gotModule = loadGotModule();
        const textConverted = jest.fn(async () => '中文');
        const response: MockedFetchResponse = {
            ok: true,
            status: 200,
            textConverted
        };
        requestMock.mockResolvedValue(response);

        const result = await gotModule.default('https://example.com/feed.xml');

        expect(result).toBe(response);
        await expect(result.textConverted?.()).resolves.toBe('中文');
        expect(requestMock).toHaveBeenCalledWith(
            'https://example.com/feed.xml',
            undefined
        );
    });

    test('allows 304 responses without throwing', async () => {
        const gotModule = loadGotModule();
        const response: MockedFetchResponse = {
            ok: false,
            status: 304,
            textConverted: jest.fn(async () => '')
        };
        requestMock.mockResolvedValue(response);

        const result = await gotModule.default('https://example.com/feed.xml');

        expect(result).toBe(response);
        await expect(result.textConverted?.()).resolves.toBe('');
    });

    test('wraps non-304 error responses in HTTPError', async () => {
        const gotModule = loadGotModule();
        const options = { method: 'POST' } as const;
        const response: MockedFetchResponse = {
            ok: false,
            status: 502,
            statusText: 'Bad Gateway'
        };
        requestMock.mockResolvedValue(response);

        await expect(
            gotModule.default('https://example.com/feed.xml', options)
        ).rejects.toMatchObject({
            name: 'HTTPError',
            message: 'Request failed with status code 502 Bad Gateway',
            response,
            options
        });
    });
});
