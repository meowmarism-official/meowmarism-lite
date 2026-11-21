# Database

An optional MariaDB that the panel installs and runs for you. It is **off by default**.

Switch it on under **Update → Optional features → Database**. The panel downloads MariaDB (about 360 MB, checked against its published SHA-256) into its data folder, creates the storage and starts it. On hosts where it cannot download MariaDB (anything but Linux on x86_64), install `mariadb-server` with your package manager; the panel then runs its own copy of it with its own data folder.

- It listens on **127.0.0.1 only**, port 3307 (`MEOW_DB_PORT` changes it). Only programs on the same machine can connect.
- The panel keeps one internal account. Every database gets its own user with rights on that database only.
- Switching it off stops the database and keeps all data.

## Two kinds of databases

- **One per server**, `srv_<instance>`: open the **Database** page of an instance and create it. Only people who may change that instance's settings see it.
- **One for the whole network**, `network`: shared by every server, the right place for data several servers use. Only owners reach it. On an instance's Database page, switch to **Whole network**.

Each page shows host, port, database, user, password and a JDBC URL to give to a plugin that needs a database. **New password** replaces it; programs using the old one lose access until you update them.

## What you can do

Create databases, create tables (column types, size, required, default, auto-increment, primary key), add and delete columns, browse rows page by page, add, edit and delete rows, and run SQL. Rows can only be edited in tables that have a primary key.

Deleting an instance does not delete its database; delete it on its Database page first if you want it gone.

The HTTP API reaches the same functions, see [api.md](api.md).

## Backups

The panel does not back up the database yet. Its files are in the data folder under `mariadb/data`; stop the database before copying them.
