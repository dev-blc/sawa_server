// The test suites import 'supertest' (a devDependency) which ships without
// type declarations, and @types/supertest is not in package.json — every
// suite importing it failed to COMPILE under ts-jest (TS7016), so `npm test`
// could never go green. Minimal ambient declaration so the suites build;
// supertest is never imported by production code. Replace with
// @types/supertest whenever a dependency change is on the table.
declare module 'supertest';
