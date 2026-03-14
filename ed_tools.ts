import { dynamicApiRequest } from "./services/apiService";
import { RequestContext } from "./services/chatPlannerService";
import { runSelectQuery } from "./services/dataService";
import { searchPokemon } from "./services/pokemonService";
import { findTopKSimilarApi } from "./services/taskSelectorService";
import { watchlistAdd, watchlistList, watchlistRemove } from "./services/watchlistService";
import { clarifyAndRefineUserInput } from "./utils/queryRefinement";
import { getSession } from "./services/conversationDb";

// ---------------------------------------------------------------------------
// Mock resolution
// ---------------------------------------------------------------------------

/**
 * Synchronously checks whether the current call to `toolName` should be
 * short-circuited with mock data. Reads the globals written by the elasticdash
 * worker subprocess before the workflow starts.
 *
 * Zero-cost no-op outside the worker: returns { mocked: false } immediately
 * when the globals are absent — no imports, no async, no side effects.
 */
function resolveMock(toolName: string): { mocked: true; result: unknown } | { mocked: false } {
    const g = globalThis as any;
    const mocks = g.__ELASTICDASH_TOOL_MOCKS__;
    if (!mocks) return { mocked: false };

    const entry = mocks[toolName];
    if (!entry || entry.mode === 'live') return { mocked: false };

    if (!g.__ELASTICDASH_TOOL_CALL_COUNTERS__) g.__ELASTICDASH_TOOL_CALL_COUNTERS__ = {};
    const counters = g.__ELASTICDASH_TOOL_CALL_COUNTERS__;
    counters[toolName] = (counters[toolName] ?? 0) + 1;
    const callNumber = counters[toolName];

    if (entry.mode === 'mock-all') {
        const data = entry.mockData ?? {};
        const result = data[callNumber] !== undefined ? data[callNumber] : data[0];
        return { mocked: true, result };
    }

    if (entry.mode === 'mock-specific') {
        const indices = entry.callIndices ?? [];
        if (indices.includes(callNumber)) {
            return { mocked: true, result: (entry.mockData ?? {})[callNumber] };
        }
        // Counter already incremented; this call runs live
        return { mocked: false };
    }

    return { mocked: false };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Records a tool call via elasticdash-test when running inside the worker
 * subprocess. Silently skips in all other environments.
 */
async function safeRecordToolCall(tool: string, input: any, result: any) {
    if (!(globalThis as any).__ELASTICDASH_WORKER__) return;
    try {
        const { recordToolCall } = await import("elasticdash-test");
        recordToolCall(tool, input, result);
    } catch (err: any) {
        if (err?.code !== 'MODULE_NOT_FOUND') {
            console.error('Logging Error in Tool:', err);
        }
    }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const checkApprovalStatus = async (input: any) => {
    const mock = resolveMock('checkApprovalStatus');
    if (mock.mocked) {
        await safeRecordToolCall('checkApprovalStatus', input, mock.result);
        return mock.result;
    }

    const { sessionId } = input as { sessionId: string };
    const TIMEOUT_MS = 5 * 60 * 1000;
    const POLL_INTERVAL_MS = 2000;
    const start = Date.now();
    let session;
    let status: string | null = null;
    let found = false;
    let timedOut = false;

    while (Date.now() - start < TIMEOUT_MS) {
        session = getSession(sessionId);
        if (session && (session.status === 'approved' || session.status === 'rejected')) {
            status = session.status;
            found = true;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (!found) {
        session = getSession(sessionId);
        if (session && (session.status === 'approved' || session.status === 'rejected')) {
            status = session.status;
            found = true;
        } else {
            timedOut = true;
        }
    }

    const result = { status, found, timedOut };
    await safeRecordToolCall('checkApprovalStatus', input, result);
    return result;
};

// Fully covered
export const dataService = async (input: any) => {
    const mock = resolveMock('dataService');
    if (mock.mocked) {
        await safeRecordToolCall('dataService', input, mock.result);
        return mock.result;
    }

    const { query } = input as { query: string };
    return await runSelectQuery(query)
    .then(async (res: any) => {
        console.log('Data Service Result:', res);
        await safeRecordToolCall('dataService', input, res);
        return res;
    })
    .catch(async (err: any) => {
        console.error('Data Service Error:', err);
        await safeRecordToolCall('dataService', input, err);
        throw err;
    });
};

// Fully covered
export const apiService = async (input: any) => {
    const mock = resolveMock('apiService');
    if (mock.mocked) {
        await safeRecordToolCall('apiService', input, mock.result);
        return mock.result;
    }

    const typedInput = input as { baseUrl: string; schema: any; userToken?: string };
    return await dynamicApiRequest(typedInput.baseUrl, typedInput.schema, typedInput.userToken)
    .then(async (res: any) => {
        console.log('API Service Result:', res);
        await safeRecordToolCall('apiService', input, res);
        return res;
    })
    .catch(async (err: any) => {
        console.error('API Service Error:', err);
        await safeRecordToolCall('apiService', input, err);
        throw err;
    });
};

// Fully covered
export const queryRefinement = async (input: any) => {
    const mock = resolveMock('queryRefinement');
    if (mock.mocked) {
        const r = mock.result as any;
        // Normalize array fields: mock data recorded before queryRefinement was
        // traced may have these fields missing (undefined). Defaulting to [] prevents
        // downstream "not iterable" errors in callers like handleQueryConceptsAndNeeds.
        const normalized = {
            ...r,
            apiNeeds: Array.isArray(r?.apiNeeds) ? r.apiNeeds : [],
            concepts: Array.isArray(r?.concepts) ? r.concepts : [],
            entities: Array.isArray(r?.entities) ? r.entities : [],
        };
        await safeRecordToolCall('queryRefinement', input, normalized);
        return normalized;
    }

    const typedInput = input as { userInput: string; userToken?: string };
    return await clarifyAndRefineUserInput(typedInput.userInput, typedInput.userToken)
    .then(async (res: any) => {
        console.log('Query Refinement Result:', res);
        await safeRecordToolCall('queryRefinement', input, res);
        return res;
    })
    .catch(async (err: any) => {
        console.error('Query Refinement Error:', err);
        await safeRecordToolCall('queryRefinement', input, err);
        throw err;
    });
};

// Fully covered
export const pokemonService = async (input: any) => {
    const mock = resolveMock('pokemonService');
    if (mock.mocked) {
        await safeRecordToolCall('pokemonService', input, mock.result);
        return mock.result;
    }

    return await searchPokemon(input)
    .then(async (res: any) => {
        console.log('Pokemon Service Result:', res);
        await safeRecordToolCall('pokemonService', input, res);
        return res;
    })
    .catch(async (err: any) => {
        console.error('Pokemon Service Error:', err);
        await safeRecordToolCall('pokemonService', input, err);
        throw err;
    });
};

// Fully covered
export const taskSelectorService = async (input: any) => {
    const mock = resolveMock('taskSelectorService');
    if (mock.mocked) {
        await safeRecordToolCall('taskSelectorService', input, mock.result);
        return mock.result;
    }

    const { queryEmbedding, topK, context } = input as { queryEmbedding: number[]; topK?: number; context?: unknown };
    try {
        const res = findTopKSimilarApi({ queryEmbedding, topK, context: context as (RequestContext | undefined) });
        console.log('Task Selector Service Result:', res.length);
        await safeRecordToolCall('taskSelectorService', input, res);
        return res;
    } catch (err: any) {
        console.error('Task Selector Service Error:', err);
        await safeRecordToolCall('taskSelectorService', input, err);
        throw err;
    }
};

// Fully covered
export const watchlistService = async (input: any) => {
    const mock = resolveMock('watchlistService');
    if (mock.mocked) {
        await safeRecordToolCall('watchlistService', input, mock.result);
        return mock.result;
    }

    const { action, payload, userToken } = input as { action: 'add' | 'remove' | 'list'; payload?: any; userToken?: string };
    if (action === 'add') return await watchlistAdd(payload, userToken);
    if (action === 'remove') return await watchlistRemove(payload, userToken);
    return await watchlistList(userToken)
    .then(async (res: any) => {
        console.log('Watchlist Service Result:', res);
        await safeRecordToolCall('watchlistService', input, res);
        return res;
    })
    .catch(async (err: any) => {
        console.error('Watchlist Service Error:', err);
        await safeRecordToolCall('watchlistService', input, err);
        throw err;
    });
};
