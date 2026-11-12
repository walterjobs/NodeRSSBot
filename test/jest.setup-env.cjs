process.env.CAMARO_FORCE_SINGLE_THREAD = 'true';

const originalWarn = console.warn;

console.warn = (...args) => {
    if (
        args[0] ===
        '[camaro] worker_threads is not available, expect performance drop. Try using Node version >= 12.'
    ) {
        return;
    }

    originalWarn(...args);
};
