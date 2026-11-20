// Shared MySQL access config for scripts (seed, import, rehash assertions).
// Can be read from environment variables or constructed programmatically.
export interface MysqlConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/** Build a MysqlConfig from an explicit object (programmatic use). */
export function makeMysqlConfig(config: {
  host?: string;
  port?: number;
  user?: string;
  password: string;
  database?: string;
}): MysqlConfig {
  return {
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 3306,
    user: config.user ?? 'root',
    password: config.password,
    database: config.database ?? 'dc',
  };
}

/** Read MysqlConfig from environment variables (CLI use). */
export function readMysqlConfig(): MysqlConfig {
  const password = process.env.MYSQL_PASSWORD;
  if (!password) {
    throw new Error('MYSQL_PASSWORD is required');
  }
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? '3306'),
    user: process.env.MYSQL_USER ?? 'root',
    password,
    database: process.env.MYSQL_DATABASE ?? 'dc',
  };
}
