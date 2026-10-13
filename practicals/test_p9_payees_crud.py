"""
Self-check for p9_payees_crud.py. Builds a throwaway database with the app's
real schema and seed data (via src/db.js), so abpay.db is never touched.

    python practicals/test_p9_payees_crud.py
"""

import os
import subprocess
import tempfile
from pathlib import Path

import p9_payees_crud as crud

ROOT = Path(__file__).resolve().parent.parent
USER, OTHER = "demo@abpay.in", "rahul@abpay.in"


def fresh_db():
    path = os.path.join(tempfile.mkdtemp(), "test.db")
    subprocess.run(["node", "-e", "require('./src/db').seed()"], cwd=ROOT, check=True,
                   env={**os.environ, "DB_FILE": path})
    return path


def expect_error(fn, *args, **kw):
    try:
        fn(*args, **kw)
    except crud.PayeeError:
        return
    raise AssertionError(f"{fn.__name__} should have refused {args} {kw}")


def main():
    conn = crud.connect(fresh_db())
    rahul_acct, ifsc = conn.execute(
        "SELECT a.number, a.ifsc FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = ?", (OTHER,)
    ).fetchone()
    start = len(crud.read_payees(conn, USER))

    # Create
    bank_id = crud.create_payee(conn, USER, "Rahul Verma", account=rahul_acct, ifsc=ifsc.lower())
    upi_id = crud.create_payee(conn, USER, "Priya", upi="priya@okaxis")
    rows = crud.read_payees(conn, USER)
    assert len(rows) == start + 2
    assert crud.get_payee(conn, USER, bank_id)["ifsc"] == ifsc  # stored upper-case
    assert crud.get_payee(conn, USER, upi_id)["kind"] == "upi"

    # Read is ordered by name
    names = [r["name"] for r in rows]
    assert names == sorted(names)

    # Update: rename, then switch a UPI payee to a bank account
    crud.update_payee(conn, USER, bank_id, name="Rahul V.")
    assert crud.get_payee(conn, USER, bank_id)["name"] == "Rahul V."
    crud.update_payee(conn, USER, upi_id, account=rahul_acct, ifsc=ifsc)
    switched = crud.get_payee(conn, USER, upi_id)
    assert switched["kind"] == "bank" and switched["upi_id"] is None

    # Validation: the same rules the app enforces
    expect_error(crud.create_payee, conn, USER, "  ", upi="x@okaxis")
    expect_error(crud.create_payee, conn, USER, "Bad", upi="not-a-upi")
    expect_error(crud.create_payee, conn, USER, "Bad", account="999999999999")
    expect_error(crud.create_payee, conn, USER, "Bad", account=rahul_acct, ifsc="HDFC123")
    expect_error(crud.create_payee, conn, "nobody@abpay.in", "X", upi="x@okaxis")

    # One customer cannot see, edit or delete another's payee
    expect_error(crud.get_payee, conn, OTHER, bank_id)
    expect_error(crud.update_payee, conn, OTHER, bank_id, name="Hijacked")
    expect_error(crud.delete_payee, conn, OTHER, bank_id)
    assert crud.get_payee(conn, USER, bank_id)["name"] == "Rahul V."

    # Delete
    crud.delete_payee(conn, USER, bank_id)
    crud.delete_payee(conn, USER, upi_id)
    assert len(crud.read_payees(conn, USER)) == start
    expect_error(crud.delete_payee, conn, USER, bank_id)

    print("All payee CRUD checks passed.")


if __name__ == "__main__":
    main()
