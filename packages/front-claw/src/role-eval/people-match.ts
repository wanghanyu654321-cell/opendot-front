import type { Person } from './performance-store.js';

export interface AliasRow { storeId: string; alias: string; personId: string; }

/** All active people matching exact display name or alias inside one store (preserves ambiguity for callers). */
export function matchPeople(people: readonly Person[], aliases: readonly AliasRow[], storeId: string, token: string): Person[] {
  const name = token.trim();
  if (!name) return [];
  const ids = new Set<string>();
  for (const person of people) {
    if (person.active && person.storeId === storeId && person.displayName === name) ids.add(person.personId);
  }
  for (const alias of aliases) {
    if (alias.storeId === storeId && alias.alias === name) ids.add(alias.personId);
  }
  return [...ids]
    .map(personId => people.find(person => person.personId === personId && person.active && person.storeId === storeId))
    .filter((person): person is Person => !!person);
}

/** Exact display name or alias inside one store. Zero or several matches stay unresolved. */
export function matchPerson(people: readonly Person[], aliases: readonly AliasRow[], storeId: string, token: string): Person | null {
  const matched = matchPeople(people, aliases, storeId, token);
  return matched.length === 1 ? matched[0]! : null;
}
