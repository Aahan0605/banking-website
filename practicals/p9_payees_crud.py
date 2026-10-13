"""
Practical 9 — Python + SQLite CRUD on the AB Pay database.

Manages a customer's saved payees (beneficiaries) in abpay.db, the same table
the web app's "Payees" page reads, so a change made here shows up in the app.

    python p9_payees_crud.py list   --user demo@abpay.in
    python p9_payees_crud.py add    --user demo@abpay.in --name "Rahul Verma" --account 501110000002 --ifsc ABPY0000001
    python p9_payees_crud.py add    --user demo@abpay.in --name "Priya" --upi priya@okaxis
    python p9_payees_crud.py update --user demo@abpay.in --id 3 --name "Rahul V."
    python p9_payees_crud.py delete --user demo@abpay.in --id 3

Uses only the standard library (sqlite3, argparse).
"""

import argparse
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent.parent / "abpay.db"

# Same rules the app enforces.
IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
UPI_RE = re.compile(r"^[\w.\-]{2,}@[a-zA-Z]{2,}$")


class PayeeError(Exception):
    """A request the bank would refuse: bad input or a record that isn't there."""


def connect(db_path):
    if not Path(db_path).exists():
        raise PayeeError(f"{db_path} not found. Run `npm start` once to create and seed it.")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def now_iso():
    # Matches the app's new Date().toISOString(): UTC, milliseconds, trailing Z.
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def user_id(conn, email):
    row = conn.execute("SELECT id FROM users WHERE email = ?", (email.lower().strip(),)).fetchone()
    if not row:
        raise PayeeError(f"No customer with email {email}.")
    return row["id"]


def validate(conn, name, account=None, ifsc=None, upi=None):
    if not name or not name.strip():
        raise PayeeError("Enter a name.")
    if upi:
        if not UPI_RE.match(upi):
            raise PayeeError(f"{upi} is not a valid UPI ID.")
        return
    if not account:
        raise PayeeError("Give either --account (with --ifsc) or --upi.")
    if ifsc and not IFSC_RE.match(ifsc.upper()):
        raise PayeeError(f"{ifsc} is not a valid IFSC (e.g. ABPY0000001).")
    # Like the app, a bank payee must be a real AB Pay account.
    if not conn.execute("SELECT 1 FROM accounts WHERE number = ?", (account,)).fetchone():
        raise PayeeError(f"No AB Pay account with number {account}.")


# ---------- CRUD ----------

def create_payee(conn, email, name, account=None, ifsc=None, upi=None):
    uid = user_id(conn, email)
    validate(conn, name, account, ifsc, upi)
    kind = "upi" if upi else "bank"
    with conn:  # commits on success, rolls back on error
        cur = conn.execute(
            """INSERT INTO payees (user_id, name, kind, account_number, ifsc, upi_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (uid, name.strip(), kind,
             None if upi else account, None if upi else (ifsc or "").upper() or None,
             upi, now_iso()),
        )
    return cur.lastrowid


def read_payees(conn, email):
    uid = user_id(conn, email)
    return conn.execute(
        "SELECT * FROM payees WHERE user_id = ? ORDER BY name", (uid,)
    ).fetchall()


def get_payee(conn, email, payee_id):
    row = conn.execute(
        "SELECT * FROM payees WHERE id = ? AND user_id = ?", (payee_id, user_id(conn, email))
    ).fetchone()
    if not row:
        raise PayeeError(f"Payee {payee_id} not found for {email}.")
    return row


def update_payee(conn, email, payee_id, name=None, account=None, ifsc=None, upi=None):
    current = get_payee(conn, email, payee_id)  # also checks ownership
    new = dict(current)
    if name is not None:
        new["name"] = name
    if upi is not None:
        new.update(kind="upi", upi_id=upi, account_number=None, ifsc=None)
    if account is not None or ifsc is not None:
        new.update(kind="bank", upi_id=None)
        if account is not None:
            new["account_number"] = account
        if ifsc is not None:
            new["ifsc"] = ifsc.upper()
    validate(conn, new["name"], new["account_number"], new["ifsc"], new["upi_id"])
    with conn:
        conn.execute(
            """UPDATE payees SET name = ?, kind = ?, account_number = ?, ifsc = ?, upi_id = ?
               WHERE id = ? AND user_id = ?""",
            (new["name"].strip(), new["kind"], new["account_number"], new["ifsc"], new["upi_id"],
             payee_id, current["user_id"]),
        )


def delete_payee(conn, email, payee_id):
    current = get_payee(conn, email, payee_id)
    with conn:
        conn.execute("DELETE FROM payees WHERE id = ? AND user_id = ?", (payee_id, current["user_id"]))


# ---------- command line ----------

def print_table(rows):
    if not rows:
        print("No payees saved.")
        return
    print(f"{'ID':>4}  {'Name':<24} {'Kind':<5} {'Account / UPI':<28} IFSC")
    for r in rows:
        target = r["upi_id"] if r["kind"] == "upi" else r["account_number"]
        print(f"{r['id']:>4}  {r['name']:<24} {r['kind']:<5} {target or '':<28} {r['ifsc'] or ''}")


def main(argv=None):
    p = argparse.ArgumentParser(description="Manage AB Pay payees in SQLite.")
    p.add_argument("--db", default=str(DEFAULT_DB), help="path to abpay.db")
    sub = p.add_subparsers(dest="cmd", required=True)

    for cmd in ("list", "add", "update", "delete"):
        s = sub.add_parser(cmd)
        s.add_argument("--user", required=True, help="customer email, e.g. demo@abpay.in")
        if cmd in ("update", "delete"):
            s.add_argument("--id", type=int, required=True)
        if cmd in ("add", "update"):
            s.add_argument("--name", required=(cmd == "add"))
            s.add_argument("--account")
            s.add_argument("--ifsc")
            s.add_argument("--upi")

    a = p.parse_args(argv)
    try:
        conn = connect(a.db)
        if a.cmd == "list":
            print_table(read_payees(conn, a.user))
        elif a.cmd == "add":
            new_id = create_payee(conn, a.user, a.name, a.account, a.ifsc, a.upi)
            print(f"Payee {new_id} saved.")
        elif a.cmd == "update":
            update_payee(conn, a.user, a.id, a.name, a.account, a.ifsc, a.upi)
            print(f"Payee {a.id} updated.")
        else:
            delete_payee(conn, a.user, a.id)
            print(f"Payee {a.id} removed.")
    except PayeeError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
