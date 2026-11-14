# Changelog

## [1.19.10](https://github.com/nejcm/market-bot/compare/v1.19.9...v1.19.10) (2026-11-14)

### Bug Fixes

- **statements:** ignore forward-period facts as ttm superseding proof (#233) ([d460dc8](https://github.com/nejcm/market-bot/commit/d460dc8355871098a01aa54081bcb5f91abc188a))

## [1.19.9](https://github.com/nejcm/market-bot/compare/v1.19.8...v1.19.9) (2026-11-14)

### Bug Fixes

- **metric-engine:** list each unresolved label once with its periods (#232) ([4b1598e](https://github.com/nejcm/market-bot/commit/4b1598e2b858bc8fd2dc8f5dc02876d9a5aa2cb8))

## [1.19.8](https://github.com/nejcm/market-bot/compare/v1.19.7...v1.19.8) (2026-11-14)

### Bug Fixes

- **codex:** skip the expected code mode notice in item counts (#231) ([718c85c](https://github.com/nejcm/market-bot/commit/718c85c2f2900b869c856b79d391656c1cc49102))

## [1.19.7](https://github.com/nejcm/market-bot/compare/v1.19.6...v1.19.7) (2026-11-12)

### Bug Fixes

- **workbench:** date annual rows only by reporting-currency filings (#230) ([24da6b3](https://github.com/nejcm/market-bot/commit/24da6b35643d9d903c9717b52e7751baaed17eb9))

## [1.19.6](https://github.com/nejcm/market-bot/compare/v1.19.5...v1.19.6) (2026-11-12)

### Bug Fixes

- **comps:** name sec ingestion lag in peer debt exclusions (#229) ([7b905cf](https://github.com/nejcm/market-bot/commit/7b905cf42b8ddb8d78d34d73942201336807e487))

## [1.19.5](https://github.com/nejcm/market-bot/compare/v1.19.4...v1.19.5) (2026-11-12)

### Bug Fixes

- **events:** accept issuer domains named by a leading-words prefix (#228) ([73fb3e2](https://github.com/nejcm/market-bot/commit/73fb3e207701ac01abc0bea627690c95c165bfdb))

## [1.19.4](https://github.com/nejcm/market-bot/compare/v1.19.3...v1.19.4) (2026-11-12)

### Bug Fixes

- **completeness:** state what the untagged-interim gap means (#227) ([bf131a7](https://github.com/nejcm/market-bot/commit/bf131a719ac778e01e62d602b1698c0a56ccddd8))

## [1.19.3](https://github.com/nejcm/market-bot/compare/v1.19.2...v1.19.3) (2026-11-12)

### Bug Fixes

- **segments:** say segment gaps cover us-gaap facts only (#226) ([4706157](https://github.com/nejcm/market-bot/commit/4706157260e062b77338690d12d15a28cc7b7e57))

## [1.19.2](https://github.com/nejcm/market-bot/compare/v1.19.1...v1.19.2) (2026-11-12)

### Bug Fixes

- **segments:** ignore geography totals outside the region unit (#225) ([2c6c1cf](https://github.com/nejcm/market-bot/commit/2c6c1cfe6dd33820a1bb87838d7226b1c21d411e))

## [1.19.1](https://github.com/nejcm/market-bot/compare/v1.19.0...v1.19.1) (2026-11-12)

### Bug Fixes

- **scoring:** record close fetch failures instead of waiting (#224) ([03de115](https://github.com/nejcm/market-bot/commit/03de115ebc097fb673024f68d82c58ad3dd2e36c))

## [1.19.0](https://github.com/nejcm/market-bot/compare/v1.18.2...v1.19.0) (2026-11-12)

### Features

- **model:** record codex item counts per exec call (#223) ([ac7ceab](https://github.com/nejcm/market-bot/commit/ac7ceab8f82677e7ec7d8fa9cff516a415bfd5c4))

## [1.18.2](https://github.com/nejcm/market-bot/compare/v1.18.1...v1.18.2) (2026-11-12)

### Bug Fixes

- **model:** disable codex built-in tools on pipeline exec calls (#222) ([4b55791](https://github.com/nejcm/market-bot/commit/4b55791d07369da890c69586d70e18461ff72e37))

## [1.18.1](https://github.com/nejcm/market-bot/compare/v1.18.0...v1.18.1) (2026-11-12)

### Bug Fixes

- **metrics:** require one prior period end for the near-zero floor (#221) ([eb1e992](https://github.com/nejcm/market-bot/commit/eb1e99201eaa5e5fb5e5446de9b9471fee0e7eea))

## [1.18.0](https://github.com/nejcm/market-bot/compare/v1.17.0...v1.18.0) (2026-11-12)

### Features

- **statements:** extend revenue across a proven concept switch (#220) ([a15f0c4](https://github.com/nejcm/market-bot/commit/a15f0c45ddc9f4e5c0895a62918639f378dd8ecd))

## [1.17.0](https://github.com/nejcm/market-bot/compare/v1.16.13...v1.17.0) (2026-11-11)

### Features

- **framework:** caveat revenue growth that spans an acquisition (#219) ([0e55a2b](https://github.com/nejcm/market-bot/commit/0e55a2b20d8d0d417d98b7d9364bbf5ff76386f8))

## [1.16.13](https://github.com/nejcm/market-bot/compare/v1.16.12...v1.16.13) (2026-11-11)

### Bug Fixes

- **history:** ignore sub-0.1% re-roundings in earlier-basis marks (#218) ([122502a](https://github.com/nejcm/market-bot/commit/122502a3af29991190768df8be74a9f0d83a2551))

## [1.16.12](https://github.com/nejcm/market-bot/compare/v1.16.11...v1.16.12) (2026-11-11)

### Bug Fixes

- **valuation:** withhold revenue-multiple verdict on stale revenue (#217) ([d6a884d](https://github.com/nejcm/market-bot/commit/d6a884dfa2fc2e85e3fc097af03870b6866bbbdb))

## [1.16.11](https://github.com/nejcm/market-bot/compare/v1.16.10...v1.16.11) (2026-11-11)

### Bug Fixes

- **metrics:** withhold yoy and cash conversion on near-zero bases (#216) ([be3efaf](https://github.com/nejcm/market-bot/commit/be3efaff90ac8be26b2fd01a1ba0c0b93500e749))

## [1.16.10](https://github.com/nejcm/market-bot/compare/v1.16.9...v1.16.10) (2026-11-11)

### Bug Fixes

- **lens:** label yahoo dividend yield as forward indicated (#215) ([f38fb95](https://github.com/nejcm/market-bot/commit/f38fb95d0102402d8950546e64cd9741aa4a4fca))

## [1.16.9](https://github.com/nejcm/market-bot/compare/v1.16.8...v1.16.9) (2026-11-11)

### Bug Fixes

- **lens:** withhold yahoo payout across currencies (#214) ([68b1a50](https://github.com/nejcm/market-bot/commit/68b1a50acbfc88d05105e6af60c795e75fad18fd))

## [1.16.8](https://github.com/nejcm/market-bot/compare/v1.16.7...v1.16.8) (2026-11-11)

### Bug Fixes

- **invariants:** catch valuation evidence beside non-usd statements (#213) ([a0d711e](https://github.com/nejcm/market-bot/commit/a0d711e001135ce1259ce2b69f4dd36a2fd8fac4))

## [1.16.7](https://github.com/nejcm/market-bot/compare/v1.16.6...v1.16.7) (2026-11-11)

### Bug Fixes

- **comps:** carry peer quote currency and gate non-usd peers (#212) ([06243f9](https://github.com/nejcm/market-bot/commit/06243f943dec2c440cbdd64e71eac5b18eca344c))

## [1.16.6](https://github.com/nejcm/market-bot/compare/v1.16.5...v1.16.6) (2026-11-11)

### Bug Fixes

- **console:** withhold stale cash and debt in the equity ledger (#211) ([9ca9956](https://github.com/nejcm/market-bot/commit/9ca9956dc35e79fbde689d58ad6f5a23c503f459))

## [1.16.5](https://github.com/nejcm/market-bot/compare/v1.16.4...v1.16.5) (2026-11-11)

### Bug Fixes

- **sec:** declare newer interim periods under another revenue tag (#210) ([e4df42f](https://github.com/nejcm/market-bot/commit/e4df42fffcfca37d7b9e3c7cd1c9f2867c69a722))

## [1.16.4](https://github.com/nejcm/market-bot/compare/v1.16.3...v1.16.4) (2026-11-11)

### Bug Fixes

- **framework:** read phase inputs at the revenue period (#209) ([cb1cf3d](https://github.com/nejcm/market-bot/commit/cb1cf3db933ddd7499cf4fca23493e8f5b3b6808))

## [1.16.3](https://github.com/nejcm/market-bot/compare/v1.16.2...v1.16.3) (2026-11-11)

### Bug Fixes

- **web-figures:** verify power and energy figures (#208) ([d712ff7](https://github.com/nejcm/market-bot/commit/d712ff7744722a2c59c9179db807fbf923be1411))

## [1.16.2](https://github.com/nejcm/market-bot/compare/v1.16.1...v1.16.2) (2026-11-11)

### Bug Fixes

- **workbench:** cite the sources behind not-meaningful cells (#207) ([738d378](https://github.com/nejcm/market-bot/commit/738d378e85a3d7d50e65c68b27e77d0fa1b42ecd))

## [1.16.1](https://github.com/nejcm/market-bot/compare/v1.16.0...v1.16.1) (2026-11-11)

### Bug Fixes

- **trends:** flag points filed before a later restatement (#206) ([5a42df5](https://github.com/nejcm/market-bot/commit/5a42df53ba5b69021af319e2c6ac84740d101858))

## [1.16.0](https://github.com/nejcm/market-bot/compare/v1.15.8...v1.16.0) (2026-11-11)

### Features

- catch defect classes across every saved run and in check (#205) ([6aad90d](https://github.com/nejcm/market-bot/commit/6aad90d84d7c6f7694a5e067dc4d18f44654ca50))

## [1.15.8](https://github.com/nejcm/market-bot/compare/v1.15.7...v1.15.8) (2026-11-11)

### Bug Fixes

- stop publishing translated, stale and sign-flipped values (#203) ([1756392](https://github.com/nejcm/market-bot/commit/1756392a69fcd743b5b78f82ce092f0e31764114))

## [1.15.7](https://github.com/nejcm/market-bot/compare/v1.15.6...v1.15.7) (2026-11-10)

### Bug Fixes

- bound scoring waits and stop electing translation currencies (#202) ([54edce9](https://github.com/nejcm/market-bot/commit/54edce9fe1c8b8dc995c337c48b42278de60d360))

## [1.15.6](https://github.com/nejcm/market-bot/compare/v1.15.5...v1.15.6) (2026-11-10)

### Bug Fixes

- **scoring:** stop holiday-short bursa windows from burning attempts (#200) ([50cff83](https://github.com/nejcm/market-bot/commit/50cff8345b615bf7378967e8bb24a20df618ab59))

## [1.15.5](https://github.com/nejcm/market-bot/compare/v1.15.4...v1.15.5) (2026-11-10)

### Bug Fixes

- **valuation:** price trailing market cap on filed diluted share counts (#199) ([d79f4da](https://github.com/nejcm/market-bot/commit/d79f4da749c6f214cc1473c775623ed6d1ee9c3c))

## [1.15.4](https://github.com/nejcm/market-bot/compare/v1.15.3...v1.15.4) (2026-11-10)

### Bug Fixes

- **scoring:** lock start-up calibration and type score rows by status (#198) ([1a79496](https://github.com/nejcm/market-bot/commit/1a79496efe531610d40007370f0aa48715e43b94))

## [1.15.3](https://github.com/nejcm/market-bot/compare/v1.15.2...v1.15.3) (2026-11-10)

### Bug Fixes

- **scoring:** persist forecast event origins; pool replay bodies (#196) ([2aea20c](https://github.com/nejcm/market-bot/commit/2aea20c25d0e038b993c2fe16d4e91272dec74fa))

## [1.15.2](https://github.com/nejcm/market-bot/compare/v1.15.1...v1.15.2) (2026-11-10)

### Bug Fixes

- **web-figures:** check figures co-cited with deterministic sources (#195) ([e901dd9](https://github.com/nejcm/market-bot/commit/e901dd9a64abfda5af7af91860d5e9061814258e))

## [1.15.1](https://github.com/nejcm/market-bot/compare/v1.15.0...v1.15.1) (2026-11-09)

### Bug Fixes

- console 500s, malformed alpha sidecars and a replayed prune path (#193) ([e19e082](https://github.com/nejcm/market-bot/commit/e19e082769ed25a7b46d9e12d6c810c1724d0170))

## [1.15.0](https://github.com/nejcm/market-bot/compare/v1.14.2...v1.15.0) (2026-11-09)

### Features

- **profile:** reuse non-sec web subject profiles by issuer report date (#192) ([0fc816a](https://github.com/nejcm/market-bot/commit/0fc816a8c0f6e11a6dad38e32b15d244cb5c6b4d))

## [1.14.2](https://github.com/nejcm/market-bot/compare/v1.14.1...v1.14.2) (2026-11-09)

### Bug Fixes

- **web-figures:** verify more web figures and fail closed on wrong units (#191) ([19619ed](https://github.com/nejcm/market-bot/commit/19619ed1d81f99cfa006f9003a05ed3c74e724f2))

## [1.14.1](https://github.com/nejcm/market-bot/compare/v1.14.0...v1.14.1) (2026-11-09)

### Bug Fixes

- **history:** stop passing prior-run item source ids to prompts (#186) ([e59700c](https://github.com/nejcm/market-bot/commit/e59700c44f9ed6cd779d7cd26c6e150833c21b23))

## [1.14.0](https://github.com/nejcm/market-bot/compare/v1.13.11...v1.14.0) (2026-11-09)

### Features

- **synthesis:** hint catalog tokens for typed figures during repair (#184) ([ed31afe](https://github.com/nejcm/market-bot/commit/ed31afe48116711b3852f439d273083fd49b17db))

### Bug Fixes

- **audit:** run warn rules on the same claim text as prune rules (#185) ([9605ece](https://github.com/nejcm/market-bot/commit/9605ece58856bd1899e687bfc90cf2b1c34f1a21))
- **eval:** count unprefixed catalog ids as metric references (#183) ([6c8dbaf](https://github.com/nejcm/market-bot/commit/6c8dbafccf6eecf6646eab447b36ec4527d9a640))
- **research:** name the field path of an unresolved metric token (#181) ([e9fe1c0](https://github.com/nejcm/market-bot/commit/e9fe1c0eec3af07c0199817973c69e9d826d67b9))
- **research:** publish a fixed gap when forecast disagreement fails (#180) ([7cada66](https://github.com/nejcm/market-bot/commit/7cada660f2283a11b1168d22b0cd69bf739a0446))
- **sec:** disclose ttm components that differ in concept or method (#179) ([93a54d9](https://github.com/nejcm/market-bot/commit/93a54d980751fad1a63fab88491f05a63165535f))
- **forecast:** stamp the info cutoff on unavailable baselines (#178) ([fecb3c1](https://github.com/nejcm/market-bot/commit/fecb3c1faccdbd01d06f4bf4c43ae46b6a930b9d))
- **runs:** list run dirs through one lister that skips shared state (#177) ([6a99a66](https://github.com/nejcm/market-bot/commit/6a99a664c647f31e4405f12490a7fff0577b37cb))
- **grid:** skip the model call when the forecast book is withheld (#176) ([832d3af](https://github.com/nejcm/market-bot/commit/832d3af3accd93fe5c0364097b252ced8371717d))

## [1.13.11](https://github.com/nejcm/market-bot/compare/v1.13.10...v1.13.11) (2026-11-09)

### Bug Fixes

- **artifacts:** fsync atomic writes and route shared writes through them (#171) ([b6a1d90](https://github.com/nejcm/market-bot/commit/b6a1d9027c01fb41df8eacccb92d9e1f4aa9e4ea))
- **forecast:** drop unbaselined grid ranges, reject duplicate grid ids (#170) ([8b1b8ad](https://github.com/nejcm/market-bot/commit/8b1b8adf0391e21a553cbd0a0307b5d6eda99065))
- **scoring:** cluster brier error by subject session, note ci limits (#169) ([6c1e83b](https://github.com/nejcm/market-bot/commit/6c1e83bd3991819e79c59a081a0d24c25c6c1089))
- **paths:** resolve every shared data path from one root (#168) ([957e9ae](https://github.com/nejcm/market-bot/commit/957e9ae452a77ed06d5bc58a3e3a3b847c702061))
- **research:** persist the run when post-synthesis steps throw (#167) ([72c2e87](https://github.com/nejcm/market-bot/commit/72c2e8704aed540e807edf9e3c7b536e0687fdd9))
- **web-figures:** drop failing quotes, keep code-rendered claims (#165) ([344a909](https://github.com/nejcm/market-bot/commit/344a9093149480393785e123858c966d72f8dcec))
- **audit:** stop counting index, form and product names as figures (#164) ([08ced2a](https://github.com/nejcm/market-bot/commit/08ced2a2bd04e7d5634d5206cf2fe6abb34ba834))

### Performance

- **replay:** reference cassette bodies instead of copying them (#172) ([fb2d1b5](https://github.com/nejcm/market-bot/commit/fb2d1b50d04919456de0681cbb4701dcb7d15840))

## [1.13.10](https://github.com/nejcm/market-bot/compare/v1.13.9...v1.13.10) (2026-11-07)

### Bug Fixes

- **web-figures:** parse glued sen and cents, withhold mixed currency (#162) ([7ad14b5](https://github.com/nejcm/market-bot/commit/7ad14b54177efd51085372c28078842575ba4a69))
- **web-figures:** check figures before point and percent unit words (#161) ([a859492](https://github.com/nejcm/market-bot/commit/a8594927a4f2a0f0dcd879b726d6cbbe02941926))
- **web-figures:** stop loose parses from verifying mismatched figures (#160) ([de3f3fd](https://github.com/nejcm/market-bot/commit/de3f3fd0ae19617005b34f8f1c0e207a362d1649))

## [1.13.9](https://github.com/nejcm/market-bot/compare/v1.13.8...v1.13.9) (2026-11-07)

### Bug Fixes

- **audit:** count compact amounts in the run's currency as figures (#159) ([e7158f3](https://github.com/nejcm/market-bot/commit/e7158f391218b812181a84215bb08bff09abaac1))

## [1.13.8](https://github.com/nejcm/market-bot/compare/v1.13.7...v1.13.8) (2026-11-07)

### Bug Fixes

- **valuation:** disclose unreconciled provider eps on issuer listings (#157) ([9fd4121](https://github.com/nejcm/market-bot/commit/9fd412181cfc56eb298f9426800a6163121c9869))
- **framework:** feed issuer report growth into the business framework (#156) ([a07bcbd](https://github.com/nejcm/market-bot/commit/a07bcbdaec92ba470e9f22cd11b6c897aa1e39df))

## [1.13.7](https://github.com/nejcm/market-bot/compare/v1.13.6...v1.13.7) (2026-11-07)

### Bug Fixes

- exchange benchmark for Bursa forecasts, performance and closes (#154) ([3d42ad6](https://github.com/nejcm/market-bot/commit/3d42ad684a036dc47d06d594c9c2bf98f79427dd))
- issuer net margin numerator and entity names counted as figures (#153) ([3be8ec3](https://github.com/nejcm/market-bot/commit/3be8ec3335c3f06bff0c9d71cf13b6674a604d82))

## [1.13.6](https://github.com/nejcm/market-bot/compare/v1.13.5...v1.13.6) (2026-11-06)

### Bug Fixes

- date trailing revenue multiples and name dated ids for dateless metric references (#152) ([01fccc0](https://github.com/nejcm/market-bot/commit/01fccc028c4d2d65b552f9eb7a04386878e21865))

## [1.13.5](https://github.com/nejcm/market-bot/compare/v1.13.4...v1.13.5) (2026-11-06)

### Bug Fixes

- **issuer:** withhold a parent-scope profit before tax row (#151) ([1a92db2](https://github.com/nejcm/market-bot/commit/1a92db26e548b929f2298b17024a0e31cb6215b8))

## [1.13.4](https://github.com/nejcm/market-bot/compare/v1.13.3...v1.13.4) (2026-11-06)

### Bug Fixes

- **issuer:** render per-share subunit asides without parentheses (#150) ([951331e](https://github.com/nejcm/market-bot/commit/951331e81c45a0997079f250e89ea504eced9049))

## [1.13.3](https://github.com/nejcm/market-bot/compare/v1.13.2...v1.13.3) (2026-11-06)

### Bug Fixes

- **web-figures:** check both endpoints of a dash range (#149) ([db1599c](https://github.com/nejcm/market-bot/commit/db1599c949c09bb0cf863e8bfe9598d6fca0a122))

## [1.13.2](https://github.com/nejcm/market-bot/compare/v1.13.1...v1.13.2) (2026-11-06)

### Bug Fixes

- **issuer:** withhold issuer report figures of unproven accounting scope (#147) ([353c488](https://github.com/nejcm/market-bot/commit/353c488d4a88d9bac0b1d48dbd7824adbbd504b9))
- **issuer:** withhold provider eps that the issuer report contradicts (#146) ([edd0c17](https://github.com/nejcm/market-bot/commit/edd0c17012eebb655f36bc2f150976f796ed4c45))

## [1.13.1](https://github.com/nejcm/market-bot/compare/v1.13.0...v1.13.1) (2026-11-06)

### Bug Fixes

- **web-figures:** withhold ambiguous table structure and signs (#144) ([fff4c02](https://github.com/nejcm/market-bot/commit/fff4c02f56d67e2c2d69ce5248311af0f8065352))
- **valuation:** withhold when reporting currency differs from quote (#143) ([0768c1b](https://github.com/nejcm/market-bot/commit/0768c1ba50c23e2f2a2d13d189a9489b84ccca66))

## [1.13.0](https://github.com/nejcm/market-bot/compare/v1.12.5...v1.13.0) (2026-11-06)

### Features

- **equity:** research non-sec listings with quote-checked figures (#142) ([3c66b18](https://github.com/nejcm/market-bot/commit/3c66b184207a032d8934e55a7bd43dba08ad6d26))

## [1.12.5](https://github.com/nejcm/market-bot/compare/v1.12.4...v1.12.5) (2026-11-05)

### Bug Fixes

- **console:** show the frozen price date on financial lens tiles (#140) ([00b23f0](https://github.com/nejcm/market-bot/commit/00b23f0f5bb584467ff12dffddb102e268e6ec97))
- **valuation:** stop publishing stale fy-as-ttm workbench multiples (#139) ([8089d46](https://github.com/nejcm/market-bot/commit/8089d46893cee238e8b6f336211334c2cd05b2e3))

## [1.12.4](https://github.com/nejcm/market-bot/compare/v1.12.3...v1.12.4) (2026-11-05)

### Bug Fixes

- **synthesis:** fix every malformed metric reference in one repair (#137) ([6c9b209](https://github.com/nejcm/market-bot/commit/6c9b209d8379f8a3e696b4871ead9e82c3c9e9e0))
- **grid:** issue events only when each leg's closes were collected (#136) ([19e4cd2](https://github.com/nejcm/market-bot/commit/19e4cd2d2f7b5cdb5364a2b35c06a71f846fa6e7))

## [1.12.3](https://github.com/nejcm/market-bot/compare/v1.12.2...v1.12.3) (2026-11-05)

### Bug Fixes

- **valuation:** price annual rows at the period's first annual report (#134) ([d4ce103](https://github.com/nejcm/market-bot/commit/d4ce1031e47a85b2aef5eb43a2a12313ba8f5349))
- **valuation:** withhold annual per-share inputs on an older share basis (#133) ([8c5442b](https://github.com/nejcm/market-bot/commit/8c5442b58d48da8527b430f10092ec934bb7855d))
- **prices:** stop re-applying splits to already adjusted yahoo closes (#132) ([bb731ce](https://github.com/nejcm/market-bot/commit/bb731ced2a36398ca268783cf3035d6c4288d8ec))

## [1.12.2](https://github.com/nejcm/market-bot/compare/v1.12.1...v1.12.2) (2026-11-05)

### Bug Fixes

- **sec:** flag pre-recast debt paired with restated continuing revenue (#131) ([492fd2f](https://github.com/nejcm/market-bot/commit/492fd2f67b4f0c542e5c74835da8359a318ba559))
- **sec:** reuse debt-face linkbases to prove older interim capex (#129) ([6ee5f4d](https://github.com/nejcm/market-bot/commit/6ee5f4d64f6d0142275368305953c266638c306d))
- **sec:** prove interim capex scope from the quarterly calc linkbase (#128) ([4c12191](https://github.com/nejcm/market-bot/commit/4c121911ab07cc0ff4700621c206012dff0364bc))

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
