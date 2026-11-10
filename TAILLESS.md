# Pi tailless upstream maintenance

The independent ACP terminal frontend lives in [apps/tailless](apps/tailless/README.md). It uses upstream `@earendil-works/pi-tui` and loads no harness or providers.

This fork retains base `9879bb44754ce42f52800371aac8cfbccf521cb7` from <https://github.com/earendil-works/pi>. The upstream source remains available alongside the app; the repository README describes tailless. The [pinned upstream README](https://github.com/earendil-works/pi/blob/9879bb44754ce42f52800371aac8cfbccf521cb7/README.md) describes the original monorepo.

`origin` points to `baliame/pi-tailless`; `upstream` points to the original Pi repository. Publication retains the upstream ancestry and the destination's initial commit. Fetch upstream and merge the selected revision into your working branch to update the retained source. Review conflicts and Pi coding guidance.

Independently update the exact Pi TUI dependency in `apps/tailless` and its lockfile when desired; a tree merge alone does not update that dependency. Rerun the app's build, checks, focused tests and real-peer checks. The extracted presentation components listed in its provenance require manual comparison with upstream. Automatic conflict-free updates are not promised.
