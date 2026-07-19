# samples/

Drop test binaries here for local development. **Do not commit real binaries
to this folder** — `.gitignore` already excludes everything except this
README.

Good test sources:

- A picoCTF RE challenge binary from your local archive
- A small utility like `/bin/ls` for sanity checks (`./test_api.sh /bin/ls`)
- Anything you build yourself with `gcc -O0` so the CFG stays readable

For a more interesting demo, a binary with a `check_password`-style
function that has actual conditional branches will produce a prettier graph
than a 200-function server daemon.
