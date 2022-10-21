// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { ClientRequest } from 'http';
import https = require('https');

/**
 * https request class in typescript to show how to manage errors and events
 * to help prevent ECONNRESET errors
 */
export class HttpRequest {
  public async send(
    options: https.RequestOptions,
    data?: unknown
  ): Promise<unknown> {
    let result = '';
    const promise = new Promise((resolve, reject) => {
      const req: ClientRequest = https.request(options, (res) => {
        console.log('statusCode:', res.statusCode);
        console.log('headers:', res.headers);

        res.on('data', (chunk) => {
          result += chunk;
        });

        res.on('error', (err) => {
          console.log(err);
          reject(err);
        });

        res.on('end', () => {
          try {
            let body = result;
            //there are empty responses

            if (res.statusCode === 200) {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              body = JSON.parse(result);
            }

            console.log(res.statusCode, result);

            resolve(body);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      });

      /***
       * handles the errors on the request
       */
      req.on('error', (err) => {
        console.log(err);
        reject(err);
      });

      /***
       * handles the timeout error
       */
      req.on('timeout', (err: unknown) => {
        console.log(err);
        req.abort();
      });

      /***
       * unhandle errors on the request
       */
      req.on('uncaughtException', (err) => {
        console.log(err);
        req.abort();
      });

      /**
       * adds the payload/body
       */
      if (data) {
        const body = JSON.stringify(data);
        req.write(body);
      }

      /**
       * end the request to prevent ECONNRESETand socket hung errors
       */
      req.end(() => {
        console.log('request ends');
      });
    });

    return promise;
  }
}
