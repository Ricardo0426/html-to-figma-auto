# Third-party notices

The DOM capture and original Figma text/paint conversion were adapted from [Open HTML to Figma](https://github.com/kevicebryan/open-htmltofigma), commit `889cd39cb708a00f1a873a9ad907b56b92113218`, by Kevin Bryan. The original MIT copyright and license are preserved in `LICENSE`.

This local derivative adds automatic sizing, batch queues, virtual filesystem asset resolution, diagnostics, Chinese UI and Group/mask output. It is not the original Community plugin.

- fflate, MIT — ZIP decoding. Its license is included as `fflate-LICENSE.txt` in the repository and installation package.
- TypeScript, Apache-2.0 — development compiler; not included in the runtime plugin.
- esbuild, MIT — development bundler; not included in the runtime plugin.
- @figma/plugin-typings, MIT — development type definitions; not included in the runtime plugin.

The build preserves bundled runtime license comments. Third-party fonts and images referenced by imported HTML remain owned by their respective authors and are not bundled with this plugin.
