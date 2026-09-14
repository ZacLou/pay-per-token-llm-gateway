/**
 * Startup guard: refuse to serve against a database that has no usable schema.
 *
 * A deploy that ships without running `prisma migrate deploy` comes up against
 * an empty database, and **nothing fails at boot**: `/health` answers, the
 * readiness probe's `SELECT 1` succeeds (it needs no tables), and the process
 * looks healthy — while every API call dies with a Prisma "table does not
 * exist" error at request time. That is a silent outage that looks like an
 * application bug.
 *
 * This converts it into a loud boot-time failure that names the exact fix.
 * It runs in `main.ts` before the HTTP server starts, so it protects every
 * deployment path — the Docker entrypoint's migrations, a Kubernetes
 * migration Job that was never applied, and a local `pnpm dev:gateway`
 * against a stale database.
 *
 * ## Push-managed databases are not the same as empty ones
 *
 * `prisma db push` — the workflow the README's Quick Start documents — creates
 * the entire schema and **no migration history**, so a missing
 * `_prisma_migrations` table on its own does not mean "no schema". Treating
 * the two as equivalent made the documented local flow unbootable, because
 * the guard runs in dev too.
 *
 * So the two states are separated:
 *
 * | Required tables | `_prisma_migrations` | Result                          |
 * | --------------- | -------------------- | ------------------------------- |
 * | present         | present              | start (migration-managed)       |
 * | present         | absent               | warn outside production; refuse in production |
 * | any missing     | either               | refuse, naming the missing table |
 *
 * Production insists on migration-managed schema because the image entrypoint
 * runs `migrate deploy` on every boot, so its absence there means migrations
 * were bypassed — and a `db push`-managed production database will drift from
 * the migration history that later deploys are applied against.
 */

/**
 * Minimal shape needed from the Prisma client, so this stays unit-testable.
 *
 * Deliberately non-generic: the guard only cares whether the query *throws*,
 * never about the rows it returns. Narrowing the signature to
 * `Promise<unknown>` keeps fake probes trivial to write.
 */
export interface SchemaProbe {
  $queryRawUnsafe(query: string): Promise<unknown>;
}

export interface SchemaGuardOptions {
  /**
   * The process's `NODE_ENV`. Only `production` refuses to start against a
   * schema that has no migration history.
   */
  nodeEnv?: string;
  /** Sink for the non-production warning. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Tables that must exist before the gateway serves traffic.
 *
 * `_prisma_migrations` is created by Prisma the first time `migrate deploy`
 * runs, so its absence distinguishes a migration-managed database from a
 * push-managed or uninitialised one. The remaining entries are the oldest,
 * most fundamental tables; they catch a partially restored database without
 * this list having to be extended for every model added since.
 */
export const MIGRATIONS_TABLE = '_prisma_migrations';
export const REQUIRED_SCHEMA_TABLES = ['Provider', 'Route', 'Payment'] as const;

/**
 * The operator-facing remediation. Kept in one place so the message and the
 * docs cannot drift apart.
 */
const REMEDIATION =
  'Apply the migrations with `npx prisma migrate deploy --schema packages/database/prisma/schema.prisma`, ' +
  'or run the container with RUN_MIGRATIONS_ON_START=true so it migrates on boot.';

/**
 * Verify the schema is usable, throwing an actionable error if it is not.
 *
 * Only "the relation is missing" is treated as a schema problem; anything
 * else (database unreachable, bad credentials, wrong database) is re-thrown
 * unchanged so it is never misreported as a schema issue.
 */
export async function assertSchemaMigrated(
  probe: SchemaProbe,
  options: SchemaGuardOptions = {},
): Promise<void> {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const warn = options.warn ?? ((message: string) => console.warn(message));

  if (!(await relationExists(probe, MIGRATIONS_TABLE))) {
    // No migration history. That is only fatal if the schema is absent too.
    if (await allRequiredTablesExist(probe)) {
      if (nodeEnv !== 'production') {
        warn(
          `Database is not migration-managed: the "${MIGRATIONS_TABLE}" table does not exist, so it was ` +
            'created with `prisma db push` (or restored) rather than `prisma migrate`. Continuing because ' +
            `NODE_ENV=${nodeEnv}; production refuses to start in this state. ${REMEDIATION}`,
        );
        return;
      }

      throw new Error(
        `Database schema is not migration-managed: the "${MIGRATIONS_TABLE}" table does not exist, so ` +
          'this database was created with `prisma db push` rather than `prisma migrate`, and will drift ' +
          `from the migration history future deploys are applied against. ${REMEDIATION}`,
      );
    }

    throw new Error(
      `Database schema is not migrated: the "${MIGRATIONS_TABLE}" table does not exist, ` +
        `so no migration has ever been applied to this database. ${REMEDIATION}`,
    );
  }

  for (const table of REQUIRED_SCHEMA_TABLES) {
    if (!(await relationExists(probe, table))) {
      throw new Error(
        `Database schema is missing the "${table}" table, so it is only partially ` +
          `migrated. ${REMEDIATION}`,
      );
    }
  }
}

async function allRequiredTablesExist(probe: SchemaProbe): Promise<boolean> {
  for (const table of REQUIRED_SCHEMA_TABLES) {
    if (!(await relationExists(probe, table))) return false;
  }
  return true;
}

async function relationExists(probe: SchemaProbe, table: string): Promise<boolean> {
  try {
    // A zero-row table is fine — we only care that the relation resolves.
    // `table` is interpolated into SQL, so it must only ever come from the
    // module-level constants above, never from input.
    await probe.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`);
    return true;
  } catch (err) {
    if (isMissingRelation(err)) return false;
    throw err;
  }
}

/**
 * True when the error means "this relation does not exist".
 *
 * `$queryRawUnsafe` surfaces the underlying Postgres failure: Prisma reports
 * `P2021` for model operations and `P2010` ("Raw query failed") for raw SQL,
 * so the driver message is the reliable signal. Matching on the message is
 * safe here because connection and authentication failures use entirely
 * different wording ("Can't reach database server", "Authentication failed"),
 * which therefore still propagate.
 */
function isMissingRelation(err: unknown): boolean {
  if ((err as { code?: string } | null)?.code === 'P2021') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /(does not exist|doesn't exist|no such table|UndefinedTable)/i.test(message);
}
