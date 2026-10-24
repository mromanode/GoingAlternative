# GoingAlternative (or popular)

Userscripts for the underground and the masses.

## Userscripts

| Site | Filtering options | Install |
| --- | --- | --- |
| MyAnimeList | Genres, themes, demographics, type, score, members, episodes, and total runtime | [Install MyAnimeList Filters](https://raw.githubusercontent.com/mromanode/GoingAlternative/main/userscripts/myanimelist-filters.user.js) |
| Letterboxd | Countries, rating, watched count, and runtime | [Install Letterboxd Filters](https://raw.githubusercontent.com/mromanode/GoingAlternative/main/userscripts/letterboxd-filters.user.js) |

Both scripts can export the filtered selection on the current page to CSV or JSON.

## Installation

1. Install [Violentmonkey](https://violentmonkey.github.io/) in your browser or use any client of preference. 
2. Open the installation link for the userscript you want.


## Usage

Open the floating **FILTERS** panel on a supported page. Changes are saved locally and applied to the available results. Use **CLEAR ALL FILTERS** to show all available results.

The panel also provides:

- **EXPORT SELECTION (CSV)** for spreadsheets and other tabular tools.
- **EXPORT SELECTION (JSON)** for structured data and scripts.
- **CLEAR CACHE** on MyAnimeList when cached metadata needs to be refreshed.

Exports include only results not hidden by the userscript. 

### Exported fields

| Userscript | Fields |
| --- | --- |
| MyAnimeList | `id`, `title`, `url`, `score`, `members`, `episodes`, `duration`, `totalRuntime`, `type`, `genres` |
| Letterboxd | `slug`, `title`, `url`, `countries`, `runtime`, `rating`, `watched` |

Durations and runtimes are expressed in minutes.

## Thank you

Many thanks [Cerdophite](https://gist.github.com/cerdophite/1f3eac536e1b270fa0ce3ad1aaddeb1d) for the inspiration.
[Reddit thread](https://www.reddit.com/r/Letterboxd/comments/1wk2u16/i_made_the_letterboxd_filters_i_always_wanted/)

## Contributing

Bug reports, small fixes, and pull requests are welcome.

- Run a syntax check before submitting a change:

  ```sh
  node --check userscripts/myanimelist-filters.user.js
  node --check userscripts/letterboxd-filters.user.js
  ```

