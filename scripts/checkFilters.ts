/*
 * Checks that substrate/FrontierEvmEvent topics
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  Interface,
  EventFragment /*, FunctionFragment*/,
} from '@ethersproject/abi';

const file = path.resolve(__dirname, '../project.yaml');

function buildInterface(abiPath: string): Interface {
  const abi = fs.readFileSync(abiPath, 'utf8');
  if (!abi) {
    throw new Error('Abi not found');
  }

  let abiObj = JSON.parse(abi) as string[];

  /*
   * Allows parsing JSON artifacts as well as ABIs
   * https://trufflesuite.github.io/artifact-updates/background.html#what-are-artifacts
   */
  if (!Array.isArray(abiObj) && (abiObj as { abi: string[] }).abi) {
    abiObj = (abiObj as { abi: string[] }).abi;
  }

  return new Interface(abiObj);
}

type Project = {
  dataSources: {
    assets?: Record<string, { file: string }>;
    processor?: {
      options?: {
        abi: string;
      };
    };
    mapping: {
      handlers: {
        kind: string;
        filter?: {
          topics?: string[];
        };
      }[];
    };
  }[];
};

function checkFilters() {
  console.log('Checking filters exist in ABIs');

  const project = yaml.load(fs.readFileSync(file, 'utf-8')) as Project;

  const issues: string[] = [];

  project.dataSources.forEach((ds) => {
    ds.mapping.handlers
      .filter((handler) => handler.kind === 'substrate/FrontierEvmEvent')
      .forEach((handler) => {
        // Check event filters
        const topics: string[] | undefined = handler?.filter?.topics;
        if (topics?.[0] && ds.assets && ds.processor?.options) {
          const topic = topics[0];

          const iface = buildInterface(
            path.resolve(ds.assets[ds.processor.options.abi].file)
          );
          const matches = Object.values(iface.events).find(
            (val) => val.format() === EventFragment.fromString(topic).format()
          );

          if (!matches) {
            issues.push(`Topic: "${topic}" not found in contract interface`);
          }
        }
      });
  });

  if (issues.length) {
    console.warn('Found issues with filters');

    issues.forEach((i) => console.warn(i));
  } else {
    console.log('SUCCESS: No issues found with filters');
  }
}

checkFilters();
