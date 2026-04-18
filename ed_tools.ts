import { dynamicApiRequest } from "./services/apiService";
import {
  fetchPokemonDetailsTool,
  searchAbilityTool,
  searchBerryTool,
  searchMoveTool,
  searchPokemonTool,
} from "./services/pokemonService";
import { clarifyAndRefineUserInput } from "./utils/queryRefinement";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WrapToolFn = <T extends (...args: any[]) => any>(name: string, fn: T) => T;
// Use the real wrapTool from elasticdash-test (supports tool mocking and auto-telemetry).
// Falls back to a passthrough stub if the package is unavailable at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wrapTool: WrapToolFn = (_name: string, fn: any) => fn;
try {
  // eval('require') bypasses Turbopack's static analysis which shows "Module not found"
  // for serverExternalPackages entries and replaces require() with an error stub at runtime.
  // Node.js resolves elasticdash-test natively via the CJS export (dist/index.cjs).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapTool = (eval('require') as (id: string) => any)('elasticdash-test').wrapTool ?? wrapTool;
} catch {
  // Not in elasticdash context — passthrough stub remains active
}

// export const checkApprovalStatus = wrapTool('checkApprovalStatus', async (input: any) => {
//     const { sessionId } = input as { sessionId: string };
//     const TIMEOUT_MS = 5 * 60 * 1000;
//     const POLL_INTERVAL_MS = 2000;
//     const start = Date.now();
//     let session;
//     let status: string | null = null;
//     let found = false;
//     let timedOut = false;

//     while (Date.now() - start < TIMEOUT_MS) {
//         session = getSession(sessionId);
//         if (session && (session.status === 'approved' || session.status === 'rejected')) {
//             status = session.status;
//             found = true;
//             break;
//         }
//         await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
//     }
//     if (!found) {
//         session = getSession(sessionId);
//         if (session && (session.status === 'approved' || session.status === 'rejected')) {
//             status = session.status;
//             found = true;
//         } else {
//             timedOut = true;
//         }
//     }

//     return { status, found, timedOut };
// });

export const apiService = wrapTool('apiService', async (input: any) => {
    const typedInput = input as { baseUrl: string; schema: any; userToken?: string };
    return await dynamicApiRequest(typedInput.baseUrl, typedInput.schema, typedInput.userToken);
});

export const queryRefinement = wrapTool('queryRefinement', async (input: any) => {
    console.log('queryRefinement input:', input);
    const typedInput = input as { userInput: string; userToken?: string };
    try {
        const res = await clarifyAndRefineUserInput(typedInput.userInput, typedInput.userToken)
        .catch(error => {
            console.error('Error in clarifyAndRefineUserInput:', error);
            throw error;
        });
        console.log('queryRefinement output:', res);
        // Ensure array fields are always arrays — guards against old recorded snapshots
        // where these fields may have been missing.
        return {
            ...res,
            apiNeeds: Array.isArray(res?.apiNeeds) ? res.apiNeeds : [],
            concepts: Array.isArray(res?.concepts) ? res.concepts : [],
            entities: Array.isArray(res?.entities) ? res.entities : [],
        };
    }
    catch (error) {
        console.error('Error in queryRefinement:', error);
        throw error;
    }
});

/**
 * Search Pokémon by name or list by page.
 * Calls PokéAPI GET /pokemon/{name} or /pokemon/?limit=20&offset=…
 */
export const searchPokemon = wrapTool('searchPokemon', async (input: any) => {
    return await searchPokemonTool(input);
});

/**
 * Fetch full Pokémon details (stats, types, abilities, moves, flavor text).
 * Calls PokéAPI GET /pokemon/{id} + /pokemon-species/{id} + per-ability details.
 */
export const fetchPokemonDetails = wrapTool('fetchPokemonDetails', async (input: any) => {
    const { id } = input as { id: number | string };
    return await fetchPokemonDetailsTool(id);
});

/**
 * Search moves by name or list by page.
 * Calls PokéAPI GET /move/{name} or /move/?limit=20&offset=…
 */
export const searchMove = wrapTool('searchMove', async (input: any) => {
    return await searchMoveTool(input);
});

/**
 * Search berries by name or list by page.
 * Calls PokéAPI GET /berry/{name} or /berry/?limit=20&offset=…
 */
export const searchBerry = wrapTool('searchBerry', async (input: any) => {
    return await searchBerryTool(input);
});

/**
 * Search abilities by name or list by page.
 * Calls PokéAPI GET /ability/{name} or /ability/?limit=20&offset=…
 */
export const searchAbility = wrapTool('searchAbility', async (input: any) => {
    return await searchAbilityTool(input);
});

