import { dynamicApiRequest } from '@/services/apiService';

/**
 * Add a Pokémon to the user's watchlist.
 */
export async function watchlistAdd(payload: any, userToken?: string) {
  return dynamicApiRequest(
    '',
    {
      path: '/pokemon/watchlist',
      method: 'post',
      requestBody: payload,
    },
    userToken
  );
}

/**
 * Remove a Pokémon from the user's watchlist.
 */
export async function watchlistRemove(payload: any, userToken?: string) {
  return dynamicApiRequest(
    '',
    {
      path: '/pokemon/watchlist',
      method: 'delete',
      requestBody: payload,
    },
    userToken
  );
}

/**
 * List/check the user's watchlist.
 */
export async function watchlistList(userToken?: string) {
  return dynamicApiRequest(
    '',
    {
      path: '/pokemon/watchlist',
      method: 'get',
      requestBody: {},
    },
    userToken
  );
}
