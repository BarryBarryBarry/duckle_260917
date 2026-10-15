// An Oracle node reads its server as one Easy Connect string (`connect`), while a
// saved Oracle connection stores host / port / database (the service name), as
// the Connections editor shows them, or a `connect` string kept verbatim for a TNS
// alias or descriptor. duckle-secrets' `oracle_connect` joins them the same way at
// run time.

/** The Easy Connect string a saved Oracle connection names, if any. */
export function oracleConnectOf(payload: Record<string, unknown> | undefined): string | undefined {
    const text = (k: string) => {
        const v = payload?.[k];
        return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    };
    const host = text('host');
    if (!host) return text('connect') || undefined;
    const port = text('port');
    const service = text('database');
    return `${host}${port ? `:${port}` : ''}${service ? `/${service}` : ''}`;
}

/** Split a plain `[//]host[:port][/service]` string into the connection's fields.
 *  Anything richer (a descriptor, an alias, `?params`, `:server`) is null: it is
 *  stored whole as `connect`. */
export function parseOracleConnect(
    connect: string,
): { host: string; port?: number; database?: string } | null {
    const m = /^(?:\/\/)?([A-Za-z0-9_.-]+)(?::(\d{1,5}))?(?:\/([A-Za-z0-9_.$#-]+))?$/.exec(connect.trim());
    if (!m) return null;
    return {
        host: m[1],
        ...(m[2] ? { port: Number(m[2]) } : {}),
        ...(m[3] ? { database: m[3] } : {}),
    };
}
