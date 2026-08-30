# Gestión Estudio CMP — integración SOS Contador

Fuente base recuperable de la aplicación CMP.

## Integración SOS incluida

1. Login en `POST /api-comunidad/login` con `SOS_USER` y `SOS_PASSWORD`.
2. Busca el CUIT objetivo `20260964233` en la respuesta del usuario.
3. Obtiene el token específico de CUIT desde `/api-comunidad/cuit/credentials/{id}`.
4. Consulta el listado documentado de clientes como primera vía segura.
5. Si SOS devuelve un campo de saldo en cada cliente, arma “Cuentas a cobrar” y resume saldos positivos por cliente.
6. Si el listado no devuelve saldo, informa los campos recibidos y permite configurar `SOS_RECEIVABLES_PATH` con el endpoint específico de cuentas corrientes sin cambiar código.

## Seguridad

- No colocar contraseñas reales en `server/index.js`, `public/index.html` ni archivos versionados.
- Copiar `.env.example` a `.env` únicamente en el servidor/local de ejecución.
- `.env` debe mantenerse fuera del repositorio y del frontend.

## Ejecutar

```bash
npm install
cp .env.example .env
# completar .env
npm start
```

Abrir `http://localhost:3000` y usar “SOS Contador”.

## Diagnóstico directo (sin Express)

En cualquier Mac/PC con Node 18+ y salida a Internet se puede validar SOS sin instalar dependencias:

```bash
SOS_USER='usuario' SOS_PASSWORD='clave' SOS_TARGET_CUIT='20260964233' node sos-diagnostico.mjs
```

La salida informa si autenticó, encontró el CUIT y qué campos devuelve el primer cliente. No guarda la clave ni escribe archivos.
