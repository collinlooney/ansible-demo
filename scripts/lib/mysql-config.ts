// Shared MySQL access config for scripts (seed, import, rehash assertions).
export interface MysqlConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

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
