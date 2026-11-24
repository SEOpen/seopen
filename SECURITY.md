# Security

## Reporting a vulnerability

Email **hello@getseopen.com** with "Security" in the subject. Please don't open a public issue or pull request for it.

Include what you found, how to reproduce it, and what it lets someone do. We'll reply within 3 working days, keep you told as we fix it, and credit you when the fix ships unless you'd rather stay anonymous.

Please don't test against other people's data or accounts on getseopen.com, run denial-of-service or automated scanning against it, or access more than you need to show the problem.

## What's covered

- This repository's code, on its default branch.
- The hosted service at getseopen.com and app.getseopen.com.

A self-hosted copy is run by whoever hosts it. Report a flaw in the code here; a problem with someone's own server or settings goes to them.

## Keys and secrets

SEOpen stores Google, PostHog, Plausible and Umami credentials encrypted with `SEOPEN_SECRET_KEY`. On a self-hosted copy, keep that key, `BETTER_AUTH_SECRET` and your DataForSEO password out of the repository and out of logs. If one leaks, rotate it at its provider, and change `SEOPEN_SECRET_KEY` only knowing that stored connections must then be made again.
