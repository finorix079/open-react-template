import { dynamicApiRequest } from "./services/apiService";
import { RequestContext } from "./services/chatPlannerService";
import { runSelectQuery } from "./services/dataService";
import { searchPokemon } from "./services/pokemonService";
import { findTopKSimilarApi } from "./services/taskSelectorService";
import { watchlistAdd, watchlistList, watchlistRemove } from "./services/watchlistService";
import { clarifyAndRefineUserInput } from "./utils/queryRefinement";
import { getSession } from "./services/conversationDb";
import { wrapTool } from "elasticdash-test";

export const checkApprovalStatus = wrapTool('checkApprovalStatus', async (input: any) => {
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

    return { status, found, timedOut };
});

export const dataService = wrapTool('dataService', async (input: any) => {
    const { query } = input as { query: string };
    return await runSelectQuery(query);
});

export const apiService = wrapTool('apiService', async (input: any) => {
    const typedInput = input as { baseUrl: string; schema: any; userToken?: string };
    return await dynamicApiRequest(typedInput.baseUrl, typedInput.schema, typedInput.userToken);
});

export const queryRefinement = wrapTool('queryRefinement', async (input: any) => {
    const typedInput = input as { userInput: string; userToken?: string };
    const res = await clarifyAndRefineUserInput(typedInput.userInput, typedInput.userToken) as any;
    // Ensure array fields are always arrays — guards against old recorded snapshots
    // where these fields may have been missing.
    return {
        ...res,
        apiNeeds: Array.isArray(res?.apiNeeds) ? res.apiNeeds : [],
        concepts: Array.isArray(res?.concepts) ? res.concepts : [],
        entities: Array.isArray(res?.entities) ? res.entities : [],
    };
});

export const pokemonService = wrapTool('pokemonService', async (input: any) => {
    return await searchPokemon(input);
});

export const taskSelectorService = wrapTool('taskSelectorService', async (input: any) => {
    const { queryEmbedding, topK, context } = input as { queryEmbedding: number[]; topK?: number; context?: unknown };
    return findTopKSimilarApi({ queryEmbedding, topK, context: context as (RequestContext | undefined) });
});

export const watchlistService = wrapTool('watchlistService', async (input: any) => {
    const { action, payload, userToken } = input as { action: 'add' | 'remove' | 'list'; payload?: any; userToken?: string };
    if (action === 'add') return await watchlistAdd(payload, userToken);
    if (action === 'remove') return await watchlistRemove(payload, userToken);
    return await watchlistList(userToken);
});
