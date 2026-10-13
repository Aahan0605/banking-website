# Open Source Technologies (3CS502ME24): Practicals 6–10

All five practicals are built on the AB Pay banking app in this repository, and none of them change how the app itself works.

| # | Practical | Files | Run |
|---|---|---|---|
| 6 | Responsive layout with **Bootstrap** | `public/practicals/bootstrap.html` | `npm start` → <http://localhost:3000/practicals/bootstrap.html> |
| 7 | DOM manipulation with **jQuery** | `public/practicals/jquery.html` | `npm start` → <http://localhost:3000/practicals/jquery.html> |
| 8 | **Pandas** data manipulation notebook | `practicals/p8_pandas_transactions.ipynb` | `jupyter notebook practicals/p8_pandas_transactions.ipynb` |
| 9 | **Python + SQLite** CRUD application | `practicals/p9_payees_crud.py` | `python3 practicals/p9_payees_crud.py list --user demo@abpay.in` |
| 10 | Exploring **GitHub Copilot** | `practicals/P10_COPILOT.md`, `practicals/p10_copilot/` | Follow the guide in VS Code |

Setup: `npm install` for the app (Node 22+), and `pip install -r practicals/requirements.txt` for Practical 8. Start the server once with `npm start` before Practicals 7–9: that creates and seeds `abpay.db`. The demo login is `demo@abpay.in` / `demo1234`.

## 6 · Bootstrap

An AB Pay landing page and account overview, built from Bootstrap 5.3. It covers:

- **Layout:** the responsive grid (`row-cols-1 / sm-2 / lg-4`) and breakpoint utilities.
- **Components:** a collapsing navbar with a dropdown, cards, badges, a progress bar, a responsive table, a list group, a carousel, an accordion, a modal form with Bootstrap validation, and toasts.
- **Customisation:** AB Pay's navy and red, the Inter font and rounded corners, applied by overriding Bootstrap's CSS variables (`--bs-primary`, `--bs-body-font-family`, `--bs-border-radius`, and button variables).

## 7 · jQuery

The page signs in to the real AB Pay API, or reuses an existing session from the main app. It then builds the statement with jQuery:

- **Creating and inserting elements:** `$("<tr>")`, `.append`, `.appendTo`, `.insertAfter`.
- **Reading and writing content and attributes:** `.text`, `.val`, `.attr`, `.data`.
- **Classes:** `.addClass`, `.removeClass`, `.toggleClass`, `.hasClass`.
- **Traversal:** `.find`, `.next`, `.children`, `.filter`, `.each`.
- **Live filtering:** `.toggle`, with the totals recalculated from the rows still visible.
- **Sorting** by detaching rows and re-appending them in the new order.
- **Event delegation:** `.on("click", "tr", …)`.
- **Effects:** `fadeIn`, `slideDown`.
- **AJAX:** `$.ajax`, with `$.when` for parallel requests.

All server data is inserted with `.text()`, never `.html()`, so nothing from the API is treated as markup.

## 8 · Pandas

The notebook loads the transaction ledger from `abpay.db` and works through each topic in the brief:

1. Loading the data.
2. Understanding its structure: `info`, `describe`, `nunique`.
3. Cleaning missing and duplicate values. The notebook first builds a deliberately messy copy (overlapping exports, lost fields), then de-duplicates on the primary key and fills the gaps.
4. Filtering with masks, `isin`, `query` and `str.contains`.
5. Sorting with `sort_values`, multi-key sorts and `nsmallest`.
6. Statistics: `groupby` / `agg`, `value_counts`, a monthly `pivot_table` and `corr`.

It is saved with its outputs, so it can be read without running it.

## 9 · Python + SQLite CRUD

`p9_payees_crud.py` manages saved payees in `abpay.db`: create, read, update and delete. It uses only the standard library (`sqlite3`, `argparse`).

- It applies the same rules as the web app: IFSC format, valid UPI IDs, and bank payees must be existing AB Pay accounts.
- Every query is parameterised.
- Each change runs in a transaction.
- One customer can never see or change another customer's payees.
- Changes made here appear immediately on the app's Payees page.

```bash
python3 practicals/p9_payees_crud.py add    --user demo@abpay.in --name "Priya" --upi priya@okaxis
python3 practicals/p9_payees_crud.py list   --user demo@abpay.in
python3 practicals/p9_payees_crud.py update --user demo@abpay.in --id 2 --name "Priya S."
python3 practicals/p9_payees_crud.py delete --user demo@abpay.in --id 2
python3 practicals/test_p9_payees_crud.py   # self-check on a throwaway database
```

## 10 · GitHub Copilot

`P10_COPILOT.md` is a guided lab of five exercises (generation, completion, `/fix` debugging, `/doc`, and `/tests`) on a personal-loan module, `p10_copilot/loan.js`. That file has gaps to fill and three planted bugs to find. Run `node --test` inside `p10_copilot/`: all tests fail at the start, and they pass once the exercises are done correctly. Record your results in the observations table at the end of the guide.
