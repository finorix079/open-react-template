/**
 * authService.ts — Stubs (no backend required)
 *
 * PokéAPI is public and requires no authentication.
 * These stubs keep existing pages compilable.
 */

export const login = async (_username: string, _password: string) => {
  return { token: 'stub-token', user: { username: _username } };
};

export const validateToken = async (_token: string) => {
  return { valid: true, user: { username: 'guest' } };
};
