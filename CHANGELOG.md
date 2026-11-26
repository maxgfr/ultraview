# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

## [1.13.4](https://github.com/maxgfr/ultraview/compare/v1.13.3...v1.13.4) (2026-11-26)


### Bug Fixes

* **viewer:** keep the page from scrolling ([1932f9c](https://github.com/maxgfr/ultraview/commit/1932f9c32313203ccb40aa5ffcdb4425a259104b)), closes [#25](https://github.com/maxgfr/ultraview/issues/25)

## [1.13.3](https://github.com/maxgfr/ultraview/compare/v1.13.2...v1.13.3) (2026-11-26)


### Bug Fixes

* **engine:** pin ultraindex 7.16.2 ([3f3b83f](https://github.com/maxgfr/ultraview/commit/3f3b83fbb51e3fa48035b30907cbc68f3dd9c21b)), closes [prisma/schema.prisma#OrderStatus](https://github.com/prisma/schema.prisma/issues/OrderStatus)
* **lens:** keep the CJK bigrams of a bridged question with --terms ([2f7f525](https://github.com/maxgfr/ultraview/commit/2f7f525529f2b697ede0f73b91ed5f6e0b7c3d43))

## [1.13.2](https://github.com/maxgfr/ultraview/compare/v1.13.1...v1.13.2) (2026-11-26)


### Bug Fixes

* **ask:** repair node ids and retry once before rejecting a turn ([6244de6](https://github.com/maxgfr/ultraview/commit/6244de627586a2fe60937196945035f5108343f9)), closes [#23](https://github.com/maxgfr/ultraview/issues/23)

## [1.13.1](https://github.com/maxgfr/ultraview/compare/v1.13.0...v1.13.1) (2026-11-26)


### Bug Fixes

* **lens:** readable, unique ids for questions in any script ([66abd5f](https://github.com/maxgfr/ultraview/commit/66abd5fd1d5a6a01f9547058ba500cc1b7551d52)), closes [#24](https://github.com/maxgfr/ultraview/issues/24)

# [1.13.0](https://github.com/maxgfr/ultraview/compare/v1.12.0...v1.13.0) (2026-11-26)


### Features

* **viewer:** chat panel ([5688610](https://github.com/maxgfr/ultraview/commit/5688610ca9f15c4f14f3c15c8d260145a7cc9884)), closes [#21](https://github.com/maxgfr/ultraview/issues/21)

# [1.12.0](https://github.com/maxgfr/ultraview/compare/v1.11.0...v1.12.0) (2026-11-26)


### Features

* **chat:** ask-model and explain for chat turns ([7f12d65](https://github.com/maxgfr/ultraview/commit/7f12d6507c3bb61f97e81a849651f567314da5f6))
* **chat:** conversations with the app ([06071a7](https://github.com/maxgfr/ultraview/commit/06071a73986d58e543f1b4924b256bbae6694bf9)), closes [#20](https://github.com/maxgfr/ultraview/issues/20)

# [1.11.0](https://github.com/maxgfr/ultraview/compare/v1.10.0...v1.11.0) (2026-11-26)


### Features

* **explain:** instant answers from proven facts ([1ecae5e](https://github.com/maxgfr/ultraview/commit/1ecae5eabdd5e5edec41fe7a114c7bfda2b4a214)), closes [#22](https://github.com/maxgfr/ultraview/issues/22)

# [1.10.0](https://github.com/maxgfr/ultraview/compare/v1.9.4...v1.10.0) (2026-11-26)


### Features

* **lens:** questions in any language with --terms ([93af919](https://github.com/maxgfr/ultraview/commit/93af919190d3d38fe08b31cbaaff6efef11d0be7)), closes [#19](https://github.com/maxgfr/ultraview/issues/19)

## [1.9.4](https://github.com/maxgfr/ultraview/compare/v1.9.3...v1.9.4) (2026-11-26)


### Bug Fixes

* **viewer:** pack unconnected entities in a grid in the Data view ([dab91c8](https://github.com/maxgfr/ultraview/commit/dab91c8de96669ef26be1412580ccfd9b6978778)), closes [#18](https://github.com/maxgfr/ultraview/issues/18)

## [1.9.3](https://github.com/maxgfr/ultraview/compare/v1.9.2...v1.9.3) (2026-11-26)


### Bug Fixes

* **drizzle:** extract tables declared through pgTableCreator ([25f7e43](https://github.com/maxgfr/ultraview/commit/25f7e4311b318da210f6fdc4310ced6af8004189)), closes [#16](https://github.com/maxgfr/ultraview/issues/16)

## [1.9.2](https://github.com/maxgfr/ultraview/compare/v1.9.1...v1.9.2) (2026-11-26)


### Bug Fixes

* **sql:** read ALTER TABLE foreign keys and merge re-created tables ([8acad8b](https://github.com/maxgfr/ultraview/commit/8acad8b9597cf6c685d13f41d95c3c5c138be3e3)), closes [#17](https://github.com/maxgfr/ultraview/issues/17)

## [1.9.1](https://github.com/maxgfr/ultraview/compare/v1.9.0...v1.9.1) (2026-11-26)


### Bug Fixes

* **ask:** write the log before announcing the outcome ([decf24a](https://github.com/maxgfr/ultraview/commit/decf24ade949ca702a67491146e174fc7d1f3502)), closes [#15](https://github.com/maxgfr/ultraview/issues/15)
* **render:** draw the current lenses, flows and model ([77e52d0](https://github.com/maxgfr/ultraview/commit/77e52d01c88efb84371cf025fab70a16b10d1019)), closes [#13](https://github.com/maxgfr/ultraview/issues/13)

# [1.9.0](https://github.com/maxgfr/ultraview/compare/v1.8.1...v1.9.0) (2026-11-26)


### Features

* rpc edges, hub summaries and live ask in the viewer ([3f708ce](https://github.com/maxgfr/ultraview/commit/3f708ce5dfb42fd89800ccdcf3b4c48fb5822b89)), closes [#8](https://github.com/maxgfr/ultraview/issues/8)
* ship the skill, references, README, evals and example ([ac4a11c](https://github.com/maxgfr/ultraview/commit/ac4a11c2d7f93bedf52746ec54d9db0253afbf76)), closes [#12](https://github.com/maxgfr/ultraview/issues/12)

## [1.8.1](https://github.com/maxgfr/ultraview/compare/v1.8.0...v1.8.1) (2026-11-26)


### Bug Fixes

* **diff:** attribute hunks to the facts they actually touch ([17695d2](https://github.com/maxgfr/ultraview/commit/17695d23515063327a02c7507729c83b6c46441e)), closes [#11](https://github.com/maxgfr/ultraview/issues/11)

# [1.8.0](https://github.com/maxgfr/ultraview/compare/v1.7.0...v1.8.0) (2026-11-26)


### Features

* live serve, lens evidence packs and the ask bridge ([22eef7a](https://github.com/maxgfr/ultraview/commit/22eef7a311a6438698d939e05bd7a59b911851cf)), closes [#10](https://github.com/maxgfr/ultraview/issues/10)

# [1.7.0](https://github.com/maxgfr/ultraview/compare/v1.6.0...v1.7.0) (2026-11-26)


### Features

* **viewer:** readable maps on large repos ([999f5de](https://github.com/maxgfr/ultraview/commit/999f5de584c5a55e75a9ccb52ad50f891a0d9d24)), closes [#9](https://github.com/maxgfr/ultraview/issues/9)

# [1.6.0](https://github.com/maxgfr/ultraview/compare/v1.5.0...v1.6.0) (2026-11-26)


### Features

* change views, agent timeline, insights and exports ([86b11cc](https://github.com/maxgfr/ultraview/commit/86b11ccf92007ea8045e903f735a82a2e0ff8aa8)), closes [#7](https://github.com/maxgfr/ultraview/issues/7)

# [1.5.0](https://github.com/maxgfr/ultraview/compare/v1.4.0...v1.5.0) (2026-11-26)


### Features

* **viewer:** offline map with semantic zoom, data, flows, lenses and tour ([6ee8e5e](https://github.com/maxgfr/ultraview/commit/6ee8e5e04fc55f2271cf9e0510e7d0b5d4b8b8d8)), closes [#5](https://github.com/maxgfr/ultraview/issues/5)

# [1.4.0](https://github.com/maxgfr/ultraview/compare/v1.3.1...v1.4.0) (2026-11-26)


### Features

* **extract:** rpc and server actions, precise externals, deduped infra ([b356fea](https://github.com/maxgfr/ultraview/commit/b356fead097b535803459efd4f365f372d4af6fa)), closes [#6](https://github.com/maxgfr/ultraview/issues/6)

## [1.3.1](https://github.com/maxgfr/ultraview/compare/v1.3.0...v1.3.1) (2026-11-26)


### Bug Fixes

* **model:** place files in the system their glob declares ([4cab7ee](https://github.com/maxgfr/ultraview/commit/4cab7eefd2ae428d5a0597b596cb6d33f6dfa3b7)), closes [#4](https://github.com/maxgfr/ultraview/issues/4)

# [1.3.0](https://github.com/maxgfr/ultraview/compare/v1.2.0...v1.3.0) (2026-11-26)


### Features

* **extract:** JS/TS routes, HTTP calls, screens and ORMs ([1b6e596](https://github.com/maxgfr/ultraview/commit/1b6e596399fe293a4cb6b4f2e2b1ba451a9bc9d6)), closes [#1](https://github.com/maxgfr/ultraview/issues/1)

# [1.2.0](https://github.com/maxgfr/ultraview/compare/v1.1.0...v1.2.0) (2026-11-26)


### Features

* **extract:** Python, SQL, jobs, externals and infra ([989f9f9](https://github.com/maxgfr/ultraview/commit/989f9f9afa04483cb363afe311c39d2c3b102c7f)), closes [#2](https://github.com/maxgfr/ultraview/issues/2)

# [1.1.0](https://github.com/maxgfr/ultraview/compare/v1.0.0...v1.1.0) (2026-11-26)


### Features

* view-model, check gate, dossier and show ([a011706](https://github.com/maxgfr/ultraview/commit/a011706d778aa206839e6c770570e0d3a072fa6d)), closes [#3](https://github.com/maxgfr/ultraview/issues/3)

# 1.0.0 (2026-11-26)


### Features

* scaffold ultraview with the extractor framework and build/status ([e5e047e](https://github.com/maxgfr/ultraview/commit/e5e047e405dc7b1648f976bcf0a398a4c39b37e6))
