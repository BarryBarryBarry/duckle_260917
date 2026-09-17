/**
 * What the Data Catalog's annotation form saves for its three fields.
 *
 * An emptied field is sent as an empty string, which the engine stores as "not
 * stated". It used to be sent as "not given", which the engine reads as "leave
 * what is there alone", so clearing an owner or a description brought the old
 * value straight back.
 */
export function annotationPatch(
    owner: string,
    description: string,
    tags: string,
): { owner: string; description: string; tags: string[] } {
    return {
        owner: owner.trim(),
        description: description.trim(),
        tags: tags
            .split(',')
            .map(t => t.trim().toLowerCase())
            .filter(Boolean),
    };
}
