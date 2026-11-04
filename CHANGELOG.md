# Changelog

## [1.12.1](https://github.com/nejcm/market-bot/compare/v1.12.0...v1.12.1) (2026-11-04)

### Bug Fixes

- **sec:** withhold FCF when capex scope can't match continuing cash flow (#127) ([806a14a](https://github.com/nejcm/market-bot/commit/806a14ae623e8ebd1f2eb01392f8033b99d79236))

## [1.12.0](https://github.com/nejcm/market-bot/compare/v1.11.2...v1.12.0) (2026-11-04)

### Features

- **sec:** add value-level ledger and diff to sweep:sec (#125) ([c3afc11](https://github.com/nejcm/market-bot/commit/c3afc11fa8610aed4b305821f19a5b3f7432c3c7))

## [1.11.2](https://github.com/nejcm/market-bot/compare/v1.11.1...v1.11.2) (2026-11-04)

### Bug Fixes

- **sec:** prove cross-filing debt and eBay short-term investments (#124) ([00566b4](https://github.com/nejcm/market-bot/commit/00566b420fdab0e8db47b04dbeefef75abfbde40))

## [1.11.1](https://github.com/nejcm/market-bot/compare/v1.11.0...v1.11.1) (2026-11-03)

### Bug Fixes

- **sec:** withhold conflicting or cross-filing debt (#123) ([df1324b](https://github.com/nejcm/market-bot/commit/df1324b0df35526b77f61b20214f86661fcba657))

## [1.11.0](https://github.com/nejcm/market-bot/compare/v1.10.1...v1.11.0) (2026-11-03)

### Features

- **sec:** prove zero debt from the filing's xbrl instance (#122) ([98c2cbf](https://github.com/nejcm/market-bot/commit/98c2cbf5e896143949936cc453d6231f68086ce5))

## [1.10.1](https://github.com/nejcm/market-bot/compare/v1.10.0...v1.10.1) (2026-11-03)

### Bug Fixes

- **sec:** withhold debt when a later comparative recasts liabilities ([8ee60e3](https://github.com/nejcm/market-bot/commit/8ee60e3f4ad33968d44008fcc5a8f4bc90ffeaca))
- **sec:** keep derived pretax income within one scope ([9fa8b97](https://github.com/nejcm/market-bot/commit/9fa8b977b9b09b36b28fcaa3872d199dbe52bbf2))

## [1.10.0](https://github.com/nejcm/market-bot/compare/v1.9.0...v1.10.0) (2026-11-02)

### Features

- **profile:** reconcile profile gaps against published sections ([36504cf](https://github.com/nejcm/market-bot/commit/36504cf3bf42ddae2247cc3298030cecff90f5b0))
- **audit:** classify peer-median claims with a model stage ([6c2e893](https://github.com/nejcm/market-bot/commit/6c2e8930e664e9b109e5792fe97aa38d16521450))
- **sec:** require same-filing text before publishing zero debt ([913a9ef](https://github.com/nejcm/market-bot/commit/913a9ef5a890a9a027e397423b96b8a22be4056e))
- **sec:** prove historical debt from each instant's own filing face ([bac59f1](https://github.com/nejcm/market-bot/commit/bac59f1224e42451162757e41071519165251a4f))

### Bug Fixes

- **sec:** label the text-proven zero debt and show its quote ([03bae85](https://github.com/nejcm/market-bot/commit/03bae8548a02f23149bb6b39bd0aad7a9aec00e0))
- **events:** format consensus estimates and declare no currency ([c4ec6d9](https://github.com/nejcm/market-bot/commit/c4ec6d97b8a24709b5ef80f313c562b22da64ec1))
- **report:** show timing unavailable for unknown earnings timing ([75c1b7f](https://github.com/nejcm/market-bot/commit/75c1b7feacf0f43392afe513963f551be26d4039))
- **console:** caption quote time only on price-dated metrics ([2e602e3](https://github.com/nejcm/market-bot/commit/2e602e3823f5b820399ffc585cbdcc326d435377))
- **sec:** drop the stale gap when a continuing series just ended ([9318778](https://github.com/nejcm/market-bot/commit/9318778e214690c5dcbf0ff8825bb9cebc7c4487))
- **sec:** require calc proof for the mrk d&a component sum ([ed9b590](https://github.com/nejcm/market-bot/commit/ed9b59054135ec7c07e9bdcf78c4defe40aef195))
- **sec:** make loans, mortgages, notes and advances need cover ([e56eb2b](https://github.com/nejcm/market-bot/commit/e56eb2b286392fd352c4f64af371c34a86bf7bb3))
- **ev:** state that preferred, nci and temp equity are carrying amounts ([cfeeee1](https://github.com/nejcm/market-bot/commit/cfeeee1af53364f87c8cd6c26de45822df811919))
- **sec:** require calc proof before the d&a face pair drops its note ([743ade5](https://github.com/nejcm/market-bot/commit/743ade5d6d81f972a964f9eab5c56e58a9836329))
- **sec:** read d&a through the full ocf calculation network ([721494e](https://github.com/nejcm/market-bot/commit/721494e2d2af5b05baa191ec3a6f3bccc08f3f61))
- **sec:** let a 10-k's own subsequent-event facts keep ttm = fy ([a442c8d](https://github.com/nejcm/market-bot/commit/a442c8d7f287c03021e7d0f9e6324423bc752929))
- **report:** scope profile gaps to the evidence the profile read ([666545d](https://github.com/nejcm/market-bot/commit/666545d5acbb7e63314547aa064b81407e209176))
- **metrics:** date provider p/e and yield by the quote, not the fetch ([26a58ae](https://github.com/nejcm/market-bot/commit/26a58aea4fb5ba9f4269cad2842a095062ffbfb1))
- **metrics:** label price-relative ratios with the quote date ([da4d222](https://github.com/nejcm/market-bot/commit/da4d222bf1d57845822a33229468d5593d7b0c12))
- **sec:** carry provenance on debt maturity rows ([861a3f7](https://github.com/nejcm/market-bot/commit/861a3f7445555d02f919dfb79b0cfeeb25dea92e))
- **sec:** keep an overdraft beside another facility in the proof ([9270cda](https://github.com/nejcm/market-bot/commit/9270cdaa18947b64b7a88d73ee7020d2ce0a6fb6))
- **events:** keep the provider earnings date outside the setup window ([5c21709](https://github.com/nejcm/market-bot/commit/5c21709a91a39aa821a9a6633407f2d11b75d5f7))
- **sec:** treat bank overdrafts as borrowings in the zero-debt proof ([79e4fc9](https://github.com/nejcm/market-bot/commit/79e4fc904c836b5f13b4cfa3efbd55da7b3112c2))
- **sec:** treat letterless prior-column face labels as blank ([a72fb92](https://github.com/nejcm/market-bot/commit/a72fb9265246b83ddc3ad06e5dccbb7b08ce5926))
- **sec:** recover debt when a newer filing repeats it partially ([c6406bb](https://github.com/nejcm/market-bot/commit/c6406bbdbb59faabdfafbd6b574cd3e8069c7963))
- **sec:** withhold workbench ev when cash or debt lags the row ([20a4429](https://github.com/nejcm/market-bot/commit/20a442914f5e956202d66f466823da87f711254e))
- **sec:** declare stale revenue at 180 days on the canonical-only path ([22ab0d6](https://github.com/nejcm/market-bot/commit/22ab0d6c207dd6dcfc63df0be2d7245b9c75e4e6))
- **sec:** let a later domestic + foreign pair restate pretax totals ([b9e8775](https://github.com/nejcm/market-bot/commit/b9e8775452229a7489ebca42a6b269e1a08ef9ea))
- **sec:** withhold stale flow series from canonical metrics ([8785654](https://github.com/nejcm/market-bot/commit/87856544716e2c4ca2d25b335f46439476e61deb))

## [1.9.0](https://github.com/nejcm/market-bot/compare/v1.8.0...v1.9.0) (2026-10-31)

### Features

- **sec:** publish fy ttm, header-only filings, d&a linkbase proof ([8f4ee41](https://github.com/nejcm/market-bot/commit/8f4ee41ac6d43517d18614ded0f49ccbae24df3d))

### Bug Fixes

- close pr review findings on debt, ttm, staleness and linkbase ([aab872f](https://github.com/nejcm/market-bot/commit/aab872fc9bff16e20db15fa2f67f7b45e484bc66))
- **sec:** withhold stale series and held-for-sale recast debt ([fd72634](https://github.com/nejcm/market-bot/commit/fd72634f612b73f089572ea47afdc42e3860b457))
- **sec:** derive pretax income from domestic and foreign components ([4036bb0](https://github.com/nejcm/market-bot/commit/4036bb031c4277cd460d7c83cba7c3518c74fc14))
- **sec:** prove debt faces and withhold held-for-sale debt ([ddc36ce](https://github.com/nejcm/market-bot/commit/ddc36ce817298a6a86b305b5a786c02a3364e397))
- **sec:** check off-face debt totals and flag uncited peer medians ([db73c2f](https://github.com/nejcm/market-bot/commit/db73c2ff77929c458cebf77525dcf8e7615d20fe))
- **sec:** switch revenue concept on a proven same-filing dual tag ([31adc1f](https://github.com/nejcm/market-bot/commit/31adc1f1ce194945728002bae4cc268ecd04c3fa))
- **sec:** settle debt scope and d&a sums from the filing face ([2af647e](https://github.com/nejcm/market-bot/commit/2af647efe34a60288fdf03f5460344278e989618))
- **prompts:** pass prior-run gaps as re-check context ([ac548dc](https://github.com/nejcm/market-bot/commit/ac548dcde0ce1e8cd4a4fe5493fba65e88fbfb53))
- **sec:** check complete debt against same-filing face rows ([9cf7b6f](https://github.com/nejcm/market-bot/commit/9cf7b6fded4fc1599c6e26aa4bbd3fa5be33c1ee))

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
