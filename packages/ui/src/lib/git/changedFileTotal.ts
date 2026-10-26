import type { GitStatus } from '@/lib/api/types';

/**
 * Every changed file in the working tree, including untracked files the server counted but did not list
 * (`untrackedOmitted`, past its listing cap). Use it wherever a count sits beside an action on all changes
 * (commit and switch adds everything, stash includes untracked files): `files.length` alone would understate it.
 */
export const changedFileTotal = (status: Pick<GitStatus, 'files' | 'untrackedOmitted'> | null | undefined): number =>
  (status?.files?.length ?? 0) + (status?.untrackedOmitted ?? 0);
