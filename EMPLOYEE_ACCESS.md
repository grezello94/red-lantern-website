# Employee access

Configure employees in **Admin → Captain App → Employee accounts**. Existing Captain accounts remain in the same account store; no separate employee migration is needed.

## Setup

1. Add or edit an employee. Choose a role, unique username/user code, active status and credentials. Captain phone access requires a PIN; the staff login also accepts a configured password.
2. Under Permissions, choose workspaces and allowed actions. Roles supply defaults; individual checkboxes override them.
3. Set table access: own/explicitly assigned orders, every table in assigned areas, or all tables. Selected dining areas restrict access in every case.
4. Save. Permission and assignment changes are checked on each authenticated request. Disabling, removing or changing credentials invalidates existing sessions.

## Defaults

| Role | Default work |
| --- | --- |
| Captain | Table orders, new rounds, KOTs, serving, moving tables, bill requests and service requests |
| Waiter | Table orders, new rounds, KOTs, serving and service requests |
| Billing User | Orders/Register, pickup/delivery orders, editing/cancellation, bill printing, settlement, table and delivery assignment, history |
| Delivery Boy | Only deliveries assigned to this employee; pickup and delivery progress |
| Online Acceptance App | QR pickup/delivery queue; accept or reject new orders |

Payments, discounts, cancellation, printer configuration and online store/item controls are separate permissions. Captain and Waiter do not receive payment or cancellation rights by default. Discounts require an explicitly configured amount/percentage cap and reason.

## Counter-created table workflow

A Billing User can open **Employee actions / assignments** on an order and assign it to an eligible Captain or Waiter in that dining area. That employee can then perform their permitted actions, regardless of who originally punched the order. Alternatively, an admin can grant a Captain area-wide table access. Ownership is not globally bypassed.

Employees sign in at `/staff-login`; Captain PIN login remains available. `/staff` provides permission-specific actions, including assignment, item quantity editing, cancellation, discounts and payment collection. Orders/Register/Kitchen retain their existing screens with restricted controls. Server authorization also rejects unauthorized direct requests.

Delivery completion does not settle payment. Kitchen ticket history remains intact after item edits; current kitchen quantities are updated and the edit is recorded. Smart KDS requires restaurant-wide kitchen scope; restricted kitchen staff use conventional KDS.

Employee account changes, PIN reveals and successful authenticated mutations are recorded in the employee audit log. Passwords cannot be revealed; saved PIN reveal uses the existing encrypted PIN vault and is admin-only.

The shared legacy Orders credential remains unrestricted for compatibility. Give employees individual accounts rather than sharing that manager credential. Admin CMS, dashboard reporting and public QR configuration are not granted by employee roles.

## Verification

Unit/server tests use a mocked database. Browser tests use mocked APIs. Live restaurant database, physical printers and deployment are not exercised by those tests.
