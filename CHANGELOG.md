# Changelog

## [1.8.0](https://github.com/nejcm/market-bot/compare/v1.7.0...v1.8.0) (2026-10-28)

### Features

- **scripts:** add sweep:packets and a hand-checked sec reference set ([9f0d81a](https://github.com/nejcm/market-bot/commit/9f0d81a31125aa5537f7be4c83e43ce9dfc52232))
- **sec:** project segment results and comparatives from inline xbrl ([799786f](https://github.com/nejcm/market-bot/commit/799786fbbfe7067fb3506880e4599ac9864440e4))
- **analytics:** record per-call model usage and add agent guidance docs ([a39f6f1](https://github.com/nejcm/market-bot/commit/a39f6f1fa90e60cde12fe487545d6df2ed1cc896))
- **valuation:** add peer-implied range and ttm revenue multiples ([13c3f56](https://github.com/nejcm/market-bot/commit/13c3f56269d75a98f665b9ae917a8ed20cd3790f))

### Bug Fixes

- **report:** cite regime drivers and sum two-line d&a ([e86b596](https://github.com/nejcm/market-bot/commit/e86b5960eec3109d1588cc0996e1b66963be07ef))
- **prompts:** drop prior and inherited gaps computable from inputs ([e7c3ab6](https://github.com/nejcm/market-bot/commit/e7c3ab6fd5b2e2e82e7c1c2f634adf9fa89040b0))
- **statements:** publish cash-flow amortization in d&a ([498ff2f](https://github.com/nejcm/market-bot/commit/498ff2fd548c99416d4d5b22a8211f7d0665134b))
- **lens:** disclose current equity and require exact identities ([fb7850c](https://github.com/nejcm/market-bot/commit/fb7850cfe335da13db8d08655211003f0bfc5c93))
- **valuation:** net debt not applicable for depository issuers ([078dd53](https://github.com/nejcm/market-bot/commit/078dd53beb3c480cf1f07bb4881299092a13cd55))
- **prompts:** check sourced values before declaring data gaps ([0c22e82](https://github.com/nejcm/market-bot/commit/0c22e827dbf458b337a93bc71db3c286431d9642))
- **sec:** refine d&a and face-statement debt recovery ([d75d96c](https://github.com/nejcm/market-bot/commit/d75d96c5d26cb2972ca51c8ffda7c0852d983093))
- **sec:** withhold capex beside unrecognized plant extensions ([1512e7c](https://github.com/nejcm/market-bot/commit/1512e7c5cadebce48a113acb4495903e8467a7b8))
- **sec:** anchor filing sections better and collect geographic revenue ([6e80ced](https://github.com/nejcm/market-bot/commit/6e80cedc42128bf5b7218051e1f8be44e6814cbf))
- **sec:** declare d&a gaps, flag segment renames and fix roic tax rate ([45c1471](https://github.com/nejcm/market-bot/commit/45c1471a3ea28d0e587f6061b57254ac457f7763))
- **sec:** tighten d&a and debt scope proofs and roic invested capital ([10e1d91](https://github.com/nejcm/market-bot/commit/10e1d910898dfb9e10de84e047f3d81460534cb4))
- **sec:** date periods across alias tags and treat ratios as quantified ([934cac4](https://github.com/nejcm/market-bot/commit/934cac4ca34b95162d01174cf0b508418c05d082))
- **sec:** keep metrics in one accounting scope ([96f3efb](https://github.com/nejcm/market-bot/commit/96f3efb538b49dbba337f1c639d562068c5b92a3))
- **valuation:** complete the ev bridge ([a59acd3](https://github.com/nejcm/market-bot/commit/a59acd304a8ce8d27b17bf872a139434304dfeeb))
- **sec:** keep section packets and withhold incomplete debt ([1885fb6](https://github.com/nejcm/market-bot/commit/1885fb636572852e8141e9281c31632c0eb250e0))
- **report:** reject placeholders and withhold negative-capex fcf ([396d130](https://github.com/nejcm/market-bot/commit/396d1300c96290a63704e33dac8aacdaf2bd541b))
- **forecast:** align baselines and confirm earnings dates ([72befcb](https://github.com/nejcm/market-bot/commit/72befcb58a66476861f723e05d221830e29cf42c))
- **forecast:** define grid range bands and issuable coverage ([d141081](https://github.com/nejcm/market-bot/commit/d141081a4329457ffe690bfe46fd12e0b83dbd09))
- **report:** triage forecast gaps and tidy report output ([6d9c6d1](https://github.com/nejcm/market-bot/commit/6d9c6d1aa36a68a3eac7faa77a9023e72335fb59))

## [1.7.0](https://github.com/nejcm/market-bot/compare/v1.6.0...v1.7.0) (2026-10-21)

### Features

- forecast baseline, eval ablation and structured metric references (#112) ([2e01832](https://github.com/nejcm/market-bot/commit/2e0183200d5cfb24353409b6bbc8fa00947bbbbd))

## [1.6.0](https://github.com/nejcm/market-bot/compare/v1.5.4...v1.6.0) (2026-10-20)

### Features

- **console:** research console v2 (#111) ([339ff6d](https://github.com/nejcm/market-bot/commit/339ff6dbaa3855403db79126fec8cb9e45bc65ad))

## [1.5.4](https://github.com/nejcm/market-bot/compare/v1.5.3...v1.5.4) (2026-10-20)

### Bug Fixes

- **forecast:** kind-aware base rate telemetry, citation classes, catalyst and split gaps (#110) ([1f19f10](https://github.com/nejcm/market-bot/commit/1f19f1039572858fa42eefbd78cb25f78c011f1a))

## [1.5.3](https://github.com/nejcm/market-bot/compare/v1.5.2...v1.5.3) (2026-10-20)

### Bug Fixes

- **synthesis:** anchor range forecasts to the ±1σ base rate (#109) ([579d631](https://github.com/nejcm/market-bot/commit/579d631b0f3f5d9feb6b1be6adcd6575940db8ae))

## [1.5.2](https://github.com/nejcm/market-bot/compare/v1.5.1...v1.5.2) (2026-10-20)

### Bug Fixes

- AMD run-review follow-ups (#108) ([4d14b40](https://github.com/nejcm/market-bot/commit/4d14b40a69d3f73c70d738b75a00152160be2143))

## [1.5.1](https://github.com/nejcm/market-bot/compare/v1.5.0...v1.5.1) (2026-10-19)

### Bug Fixes

- AMD deep run-review fixes (gap cause, provenance, web profile, eval tooling) (#107) ([6190713](https://github.com/nejcm/market-bot/commit/61907139d74a8e126f01c21b994314e5a94bb528))

## [1.5.0](https://github.com/nejcm/market-bot/compare/v1.4.0...v1.5.0) (2026-10-17)

### Features

- **news:** same-day grace window and title/symbol floor (#106) ([b435cfe](https://github.com/nejcm/market-bot/commit/b435cfe540a1145ebe6c3b6bfbb8486eb386dfc8))

## [1.4.0](https://github.com/nejcm/market-bot/compare/v1.3.0...v1.4.0) (2026-10-16)

### Features

- **replay:** iterate on real run data in seconds instead of 12-minute live runs (#105) ([4477fd4](https://github.com/nejcm/market-bot/commit/4477fd460cf364087bda190ffa3eaf30a627e4a4))

## [1.3.0](https://github.com/nejcm/market-bot/compare/v1.2.2...v1.3.0) (2026-10-16)

### Features

- deterministic metric engine with narrative metric references (#104) ([426c7bc](https://github.com/nejcm/market-bot/commit/426c7bcb433424b677f9a9645581f6c6582bcc42))

## [1.2.2](https://github.com/nejcm/market-bot/compare/v1.2.1...v1.2.2) (2026-10-14)

### Bug Fixes

- **capital-ownership:** select only year-length annual facts (#103) ([dd42fe0](https://github.com/nejcm/market-bot/commit/dd42fe0225f426be30498d301db64427900446a4))

## [1.2.1](https://github.com/nejcm/market-bot/compare/v1.2.0...v1.2.1) (2026-10-14)

### Bug Fixes

- payout gap staleness, peer median basis, earnings date conflicts (#102) ([eed8bbf](https://github.com/nejcm/market-bot/commit/eed8bbf1376844c02f6e8179653c3d5b1d53fdfe))

## [1.2.0](https://github.com/nejcm/market-bot/compare/v1.1.0...v1.2.0) (2026-10-14)

### Features

- **skills:** write run-review report to .reviews, digest in chat ([4c969b6](https://github.com/nejcm/market-bot/commit/4c969b605600216c6bc40e81da6952dc5dbcb8fc))

### Bug Fixes

- **skills:** tighten run-review report file and digest rules ([34c9f81](https://github.com/nejcm/market-bot/commit/34c9f81f5df515e2b7ea0bb2340602d65091edc6))

## [1.1.0](https://github.com/nejcm/market-bot/compare/v1.0.0...v1.1.0) (2026-10-14)

### Features

- **release:** add semver releases and tag runs with app version ([649da92](https://github.com/nejcm/market-bot/commit/649da9279c2b0f7dda415c49ae9bf7d62184015a))
