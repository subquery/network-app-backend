import { JestConfigWithTsJest } from 'ts-jest';
import * as dotenv from 'dotenv';

export default function globalSetup(
  globalConfig: JestConfigWithTsJest,
  projectConfig: JestConfigWithTsJest
): void {
  dotenv.config({ path: '.env.test' });
}
