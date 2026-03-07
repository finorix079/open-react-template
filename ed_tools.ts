import { recordToolCall } from "elasticdash-test";
import { dynamicApiRequest } from "./services/apiService";
import { RequestContext } from "./services/chatPlannerService";
import { runSelectQuery } from "./services/dataService";
import { searchPokemon } from "./services/pokemonService";
import { findTopKSimilarApi } from "./services/taskSelectorService";
import { watchlistAdd, watchlistList, watchlistRemove } from "./services/watchlistService";
import { clarifyAndRefineUserInput } from "./utils/queryRefinement";

// Fully covered
export const apiService = async (input: any) => {
    const typedInput = input as { baseUrl: string; schema: any; userToken?: string };
    return await dynamicApiRequest(typedInput.baseUrl, typedInput.schema, typedInput.userToken)
    .then((res: any) => {
        console.log('API Service Result:', res);
        recordToolCall('apiService', input, res);
        return res;
    })
    .catch((err: any) => {
        console.error('API Service Error:', err);
        recordToolCall('apiService', input, err);
        throw err;
    });
};

// Fully covered
export const queryRefinement = async (input: any) => {
    const typedInput = input as { userInput: string; userToken?: string };
    return await clarifyAndRefineUserInput(typedInput.userInput, typedInput.userToken)
    .then((res: any) => {
        console.log('Query Refinement Result:', res);
        recordToolCall('queryRefinement', input, res);
        return res;
    })
    .catch((err: any) => {
        console.error('Query Refinement Error:', err);
        recordToolCall('queryRefinement', input, err);
        throw err;
    }); 
};

// Fully covered
export const dataService = async (input: any) => {
    const typedInput = input as { query: string };
    return await runSelectQuery(typedInput.query)
    .then((res: any) => {
        console.log('Data Service Result:', res);
        recordToolCall('dataService', input, res);
        return res;
    })
    .catch((err: any) => {
        console.error('Data Service Error:', err);
        recordToolCall('dataService', input, err);
        throw err;
    });
};

// Fully covered
export const pokemonService = async (input: any) => {
    return await searchPokemon(input)
    .then((res: any) => {
        console.log('Pokemon Service Result:', res);
        recordToolCall('pokemonService', input, res);
        return res;
    })
    .catch((err: any) => {
        console.error('Pokemon Service Error:', err);
        recordToolCall('pokemonService', input, err);
        throw err;
    });
};

// Fully covered
export const taskSelectorService = async (input: any) => {
    const { queryEmbedding, topK, context } = input as { queryEmbedding: number[]; topK?: number; context?: unknown };
    return await findTopKSimilarApi({ queryEmbedding, topK, context: context as (RequestContext | undefined) })
    .then((res: any) => {
        console.log('Task Selector Service Result:', res);
        recordToolCall('taskSelectorService', input, res);
        return res;
    })
    .catch((err: any) => {
        console.error('Task Selector Service Error:', err);
        recordToolCall('taskSelectorService', input, err);
        throw err;
    });
};

// Fully covered
export const watchlistService = async (input: any) => {
    const { action, payload, userToken } = input as { action: 'add' | 'remove' | 'list'; payload?: any; userToken?: string };
    if (action === 'add') return await watchlistAdd(payload, userToken);
    if (action === 'remove') return await watchlistRemove(payload, userToken);
    return await watchlistList(userToken)
    .then((res: any) => {
        console.log('Watchlist Service Result:', res);
        recordToolCall('watchlistService', input, res);
        return res;
    })
    .catch((err: any) => {
        console.error('Watchlist Service Error:', err);
        recordToolCall('watchlistService', input, err);
        throw err;
    });
};