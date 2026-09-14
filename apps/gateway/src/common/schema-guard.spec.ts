import {
  assertSchemaMigrated,
  MIGRATIONS_TABLE,
  REQUIRED_SCHEMA_TABLES,
  type SchemaProbe,
} from './schema-guard';

/** A probe whose relations are exactly the ones named in `present`. */
function probeWith(present: string[]): SchemaProbe {
  return {
    $queryRawUnsafe: jest.fn(async (query: string) => {
      const match = /FROM "([^"]+)"/.exec(query);
      const table = match?.[1] ?? '';
      if (!present.includes(table)) {
        // Shape of the error Prisma raises for raw SQL against a missing
        // relation: P2010 wrapping the Postgres driver message.
        throw Object.assign(
          new Error(
            `Raw query failed. Code: \`42P01\`. Message: \`relation "${table}" does not exist\``,
          ),
          { code: 'P2010' },
        );
      }
      return [];
    }),
  };
}

const FULLY_MIGRATED = [MIGRATIONS_TABLE, ...REQUIRED_SCHEMA_TABLES];

describe('assertSchemaMigrated', () => {
  it('resolves when the migrations table and all required tables exist', async () => {
    await expect(assertSchemaMigrated(probeWith(FULLY_MIGRATED))).resolves.toBeUndefined();
  });

  it('resolves when the required tables exist but are empty', async () => {
    // `SELECT 1 ... LIMIT 1` returns zero rows for an empty table — that must
    // not be mistaken for a missing relation.
    await expect(assertSchemaMigrated(probeWith(FULLY_MIGRATED))).resolves.toBeUndefined();
  });

  it('fails with the remediation when no migration has ever been applied', async () => {
    // Regression: a fresh deploy booted against an empty schema, reported
    // healthy, and failed every API call with a Prisma "table does not exist".
    const probe = probeWith([]);

    await expect(assertSchemaMigrated(probe)).rejects.toThrow(
      new RegExp(`"${MIGRATIONS_TABLE}" table does not exist`),
    );
    await expect(assertSchemaMigrated(probe)).rejects.toThrow(/RUN_MIGRATIONS_ON_START=true/);
    await expect(assertSchemaMigrated(probe)).rejects.toThrow(/migrate deploy/);
  });

  it('names the specific table when the schema is only partially migrated', async () => {
    const probe = probeWith([MIGRATIONS_TABLE, 'Provider']);

    await expect(assertSchemaMigrated(probe)).rejects.toThrow(/missing the "Route" table/);
  });

  it('recognises the P2021 code Prisma raises for model operations', async () => {
    const probe: SchemaProbe = {
      $queryRawUnsafe: jest.fn(async () => {
        throw Object.assign(new Error('The table `public.Provider` does not exist'), {
          code: 'P2021',
        });
      }),
    };

    await expect(assertSchemaMigrated(probe)).rejects.toThrow(/not migrated/);
  });

  it('does NOT report a connection failure as a schema problem', async () => {
    // A database that is merely unreachable must surface as itself, so the
    // operator is not sent chasing a migration that is already applied.
    const probe: SchemaProbe = {
      $queryRawUnsafe: jest.fn(async () => {
        throw Object.assign(
          new Error(
            "Can't reach database server at `postgres:5432`. Please make sure your database server is running.",
          ),
          { code: 'P1001' },
        );
      }),
    };

    await expect(assertSchemaMigrated(probe)).rejects.toThrow(/Can't reach database server/);
    await expect(assertSchemaMigrated(probe)).rejects.not.toThrow(/not migrated/);
  });

  it('does NOT report an authentication failure as a schema problem', async () => {
    const probe: SchemaProbe = {
      $queryRawUnsafe: jest.fn(async () => {
        throw Object.assign(new Error('Authentication failed against database server'), {
          code: 'P1000',
        });
      }),
    };

    await expect(assertSchemaMigrated(probe)).rejects.toThrow(/Authentication failed/);
  });

  it('only reads — it never writes to the database', async () => {
    const probe = probeWith(FULLY_MIGRATED);

    await assertSchemaMigrated(probe);

    const queries = (probe.$queryRawUnsafe as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(queries.every((q) => /^SELECT 1 FROM "[A-Za-z_]+" LIMIT 1$/.test(q))).toBe(true);
  });
});
