import { apiService } from '@/ed_tools';

/**
 * Add a Pokémon to the user's watchlist.
 */
export async function watchlistAdd(payload: any, userToken?: string) {
  return apiService({
    baseUrl: process.env.NEXT_PUBLIC_ELASTICDASH_API || '',
    schema: {
      path: '/pokemon/watchlist',
      method: 'post',
      requestBody: payload,
    },
    userToken
  });
}

/**
 * Remove a Pokémon from the user's watchlist.
 */
export async function watchlistRemove(payload: any, userToken?: string) {
  return apiService({
    baseUrl: process.env.NEXT_PUBLIC_ELASTICDASH_API || '',
    schema: {
      path: '/pokemon/watchlist',
      method: 'delete',
      requestBody: payload,
    },
    userToken
  });
}

/**
 * List/check the user's watchlist.
 */
export async function watchlistList(userToken?: string) {
  return apiService({
    baseUrl: process.env.NEXT_PUBLIC_ELASTICDASH_API || '',
    schema: {
      path: '/pokemon/watchlist',
      method: 'get',
      requestBody: {},
    },
    userToken
  });
}
