import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names with conditional support and Tailwind conflict resolution.
 *
 * `clsx` flattens conditional/array/object inputs; `twMerge` then collapses
 * conflicting Tailwind utilities so the LAST class wins (e.g.
 * `cn('px-2 py-1', 'px-4')` → `'py-1 px-4'`). A plain `join(' ')` would leave
 * both `px-*` classes in the output, letting CSS source order — not the
 * caller's intent — decide the final padding.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
