# PowerSnap by PocketBI

PowerSnap is the guest-first data-quality diagnosis surface for the PocketBI business-tool family.

## MVP contract

1. Upload a CSV without creating an account.
2. Diagnose the biggest structural/data-quality problems immediately.
3. Explain why those problems matter to reporting and operations.
4. Apply deterministic cleanup rules in one click.
5. Export the cleaned CSV.

Current checks include blank/duplicate headers, missing values, mixed types, formatted numeric text, whitespace, and exact duplicate rows.

## Product rules

- no registration wall before the user sees value
- local/browser processing whenever practical
- AI can improve explanations later, but basic diagnosis and cleanup must not depend on AI
- never send confidential datasets to an LLM just to perform deterministic checks
- keep the path from upload to useful result extremely short
- use PocketBI ID only for paid workflows such as saved templates, batch processing, API access, organizations, and usage history

## Planned business layer

- batch processing
- reusable cleaning templates
- API keys and a versioned cleaning endpoint
- organization/team accounts
- usage records and quotas
- validated custom cleaning instructions
- automatic pipeline/integration mode

A new domain is not required for launch. PowerSnap can ship under the PocketBI domain/subdomain structure and move later if a standalone brand becomes valuable.
