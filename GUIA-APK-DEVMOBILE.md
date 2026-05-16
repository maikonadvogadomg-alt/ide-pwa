# Como gerar o APK do DevMobile (app mobile completo)

O DevMobile já está 100% configurado para gerar APK via Expo EAS Build.
Conta: maikon12 | Projeto ID: 57007145-e348-4887-84e6-3c20644f5ec4

## Método 1: EAS Build (recomendado — gratuito, sem instalar Android SDK)

### No celular ou computador, abra o terminal e rode:

```bash
# 1. Instalar EAS CLI
npm install -g eas-cli

# 2. Fazer login na sua conta Expo
eas login
# Usuário: maikon12
# (coloque sua senha da conta expo.dev)

# 3. Entrar na pasta do projeto
cd SK-DevMobile-v4-source/devmobile-fix

# 4. Instalar dependências
npm install

# 5. Gerar o APK (profile "preview" = APK direto, sem Play Store)
eas build --platform android --profile preview

# 6. Aguardar (~10 minutos) e baixar o APK pelo link que aparecer
```

### Onde baixar depois:
- Acesse https://expo.dev/accounts/maikon12/projects/app-ide/builds
- Clique no build mais recente
- Baixe o arquivo .apk e instale no celular

---

## Método 2: GitHub Actions (sem precisar do terminal)

1. Crie um repo no GitHub com o código do DevMobile
2. Adicione o secret `EXPO_TOKEN` nas configurações do repo
   - Gere o token em: https://expo.dev/accounts/maikon12/settings/access-tokens
3. Crie o arquivo `.github/workflows/eas-build.yml` com:

```yaml
name: EAS Build APK
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g eas-cli
      - run: npm install
      - run: eas build --platform android --profile preview --non-interactive
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
```

4. Faça push e aguarde o APK aparecer em expo.dev

---

## Dica importante
No celular Android para instalar:
**Configurações → Segurança → Instalar apps de fontes desconhecidas → Permitir**
