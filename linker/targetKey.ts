/**
 * Identity of one virtual-link target.
 *
 * A heading counts as a target of its own: "Only link once" has to keep one
 * link per heading, otherwise a glossary written as headings inside a single
 * note collapses to a single link (all headings would share the note's path).
 *
 * Kept in a dependency-free module so the rule can be unit tested without the
 * Obsidian runtime (virtualLinkMatch imports too much for the test harness).
 */
export function targetKeyOf(path: string, headerId?: string): string {
    return headerId ? `${path}#${headerId}` : path;
}
