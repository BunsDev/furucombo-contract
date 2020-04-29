#!/bin/bash
set -o errexit

#!/bin/sh
FILES=$(git diff --cached --name-only --diff-filter=ACMR "*.js" "*.sol" | sed 's| |\\ |g')
[ -z "$FILES" ] && exit 0

# Prettify all selected files
echo "$FILES" | xargs ./node_modules/prettier/bin-prettier.js --write

# Add back the modified/prettified files to staging
echo "$FILES" | xargs git add

exit 0
