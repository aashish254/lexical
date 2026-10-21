/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as fs from 'node:fs';
import * as path from 'node:path';
import {expect, test} from 'vitest';

// Bundlers replace only process.env.NODE_ENV: any other process.env read in
// shipped source throws "process is not defined" in a browser.
test('shipped source reads no process.env but NODE_ENV', () => {
  const src = path.resolve(__dirname, '../..');
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') {
          visit(p);
        }
      } else if (/\.tsx?$/.test(entry.name)) {
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/process\.env\.(\w+)/g)) {
          if (m[1] !== 'NODE_ENV') {
            offenders.push(`${path.relative(src, p)}: process.env.${m[1]}`);
          }
        }
      }
    }
  };
  visit(src);
  expect(offenders).toEqual([]);
});
