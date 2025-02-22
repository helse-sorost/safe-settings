# Oppsett før Helse Sør-Øst

De tilpassede workflow'ene for å kjøre denne for Helse Sør-Øst trenger disse secrets i miljøene `create-pre-release` og `create-release`:

- REGISTRY: url til det private containter-registry som brukes for deploy
- AZURE_CLIENT_ID: ClientId for UMI brukt til deploy
- AZURE_TENANT_ID: TentantId for tentnant registry befinner seg i
- AZURE_SUBSCRIPTION_ID: SubscriptionId for subscription registry befinner seg i
