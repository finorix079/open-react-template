import { dynamicApiRequest } from "./services/apiService";
import { RequestContext } from "./services/chatPlannerService";
import { runSelectQuery } from "./services/dataService";
import { searchPokemon } from "./services/pokemonService";
import { findTopKSimilarApi } from "./services/taskSelectorService";
import { watchlistAdd, watchlistList, watchlistRemove } from "./services/watchlistService";
import { clarifyAndRefineUserInput } from "./utils/queryRefinement";

// Fully covered
export const dataService = async (input: any) => {
    const { query } = input as { query: string };
    return await runSelectQuery(query)
    .then(async (res: any) => {
        console.log('Data Service Result:', res);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('dataService', input, res);
        }
        catch (logError) {
            console.error('Logging Error in Data Service:', logError);
        }
        return res;
    })
    .catch(async (err: any) => {
        console.error('Data Service Error:', err);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('dataService', input, err);
        }
        catch (logError) {
            console.error('Logging Error in Data Service:', logError);
        }
        throw err;
    });
};

// Fully covered
export const apiService = async (input: any) => {
    const typedInput = input as { baseUrl: string; schema: any; userToken?: string };
    return await dynamicApiRequest(typedInput.baseUrl, typedInput.schema, typedInput.userToken)
    .then(async (res: any) => {
        console.log('API Service Result:', res);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('apiService', input, res);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        return res;
    })
    .catch(async (err: any) => {
        console.error('API Service Error:', err);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('apiService', input, err);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        throw err;
    });
};

// Fully covered
export const queryRefinement = async (input: any) => {
    const typedInput = input as { userInput: string; userToken?: string };
    return await clarifyAndRefineUserInput(typedInput.userInput, typedInput.userToken)
    .then(async (res: any) => {
        console.log('Query Refinement Result:', res);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('queryRefinement', input, res);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        return res;
    })
    .catch(async (err: any) => {
        console.error('Query Refinement Error:', err);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('queryRefinement', input, err);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        throw err;
    }); 
};

// Fully covered
export const pokemonService = async (input: any) => {
    return await searchPokemon(input)
    .then(async (res: any) => {
        console.log('Pokemon Service Result:', res);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('pokemonService', input, res);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        return res;
    })
    .catch(async (err: any) => {
        console.error('Pokemon Service Error:', err);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('pokemonService', input, err);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        throw err;
    });
};

// Fully covered
export const taskSelectorService = async (input: any) => {
    const { queryEmbedding, topK, context } = input as { queryEmbedding: number[]; topK?: number; context?: unknown };
    try {
        const res = findTopKSimilarApi({ queryEmbedding, topK, context: context as (RequestContext | undefined) });
        console.log('Task Selector Service Result:', res);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('taskSelectorService', input, res);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        return res;
    } catch (err: any) {
        console.error('Task Selector Service Error:', err);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('taskSelectorService', input, err);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        throw err;
    }
};

// Fully covered
export const watchlistService = async (input: any) => {
    const { action, payload, userToken } = input as { action: 'add' | 'remove' | 'list'; payload?: any; userToken?: string };
    if (action === 'add') return await watchlistAdd(payload, userToken);
    if (action === 'remove') return await watchlistRemove(payload, userToken);
    return await watchlistList(userToken)
    .then(async (res: any) => {
        console.log('Watchlist Service Result:', res);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('watchlistService', input, res);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        return res;
    })
    .catch(async (err: any) => {
        console.error('Watchlist Service Error:', err);
        try {
            const { recordToolCall } = await import("elasticdash-test");
            recordToolCall('watchlistService', input, err);
        }
        catch (logError) {
            console.error('Logging Error in API Service:', logError);
        }
        throw err;
    });
};