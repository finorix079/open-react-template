/**
 * teamService.ts — Stubs (no backend required)
 *
 * PokéAPI has no user-specific storage for teams.
 * These stubs keep existing pages compilable.
 */

export const getTeams = async () => {
  return { success: true, result: [] };
};

export const createTeam = async (_teamName: string) => {
  return { success: true, result: { id: 0, teamName: _teamName } };
};

export const deleteTeam = async (_teamId: number) => {
  return { success: true };
};

export const addPokemonToTeam = async (_teamId: number, _pokemonId: number) => {
  return { success: true };
};
