# Poner pokesurvivor.xyz en marcha

> Nota de despliegue: el destino actual es **Cloudflare Pages**. Este documento
> conserva las comprobaciones históricas de dominio y DNS, pero ya no se debe
> apuntar el dominio a GitHub Pages. El código fuente vive en el fork de GitHub
> y Cloudflare Pages publica la rama `main`.

El dominio está comprado en **Cloudflare** y todavía no apunta a ningún sitio.
Todo lo del código ya está preparado; la publicación se hace desde Cloudflare
Pages con el repositorio de GitHub como fuente.

Estado a 10-10-2026:

- [x] Dominio comprado en Cloudflare (servidores DNS de Cloudflare activos).
- [x] `pokesurvivor.xyz` y `www.pokesurvivor.xyz` añadidos a Firebase → dominios
      autorizados (el inicio de sesión con Google funcionará desde el primer día).
- [x] Páginas en español e inglés, sitemap, robots, 404 e imagen para compartir,
      generadas y probadas (Lighthouse: SEO 100, accesibilidad 100).
- [x] Script del paso final ensayado: `tools/activar_dominio.sh`.
- [x] Paso 1 · DNS en Cloudflare (**TÚ**)
- [x] Paso 2 · Verificar el dominio en GitHub (**TÚ**, recomendado)
- [x] Paso 3 · Paso final (**YO**): hecho el 10-10-2026, con HTTPS
- [ ] Paso 4 · Google Search Console y Bing (**TÚ**)

---

## Paso 1 · DNS en Cloudflare (TÚ, 5 minutos)

1. Entra en <https://dash.cloudflare.com> → elige **pokesurvivor.xyz** →
   menú de la izquierda **DNS → Records**.
2. Pulsa **Add record** y crea estos 9 registros. En todos, el interruptor
   **Proxy status** tiene que quedar en **DNS only** (nube **gris**, no naranja).

   | Type | Name | IPv4 / IPv6 / Target |
   |---|---|---|
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | AAAA | `@` | `2606:50c0:8000::153` |
   | AAAA | `@` | `2606:50c0:8001::153` |
   | AAAA | `@` | `2606:50c0:8002::153` |
   | AAAA | `@` | `2606:50c0:8003::153` |
   | CNAME | `www` | `jpter78.github.io` |

   Son las direcciones de GitHub Pages, que es donde está el juego.

> **Por qué la nube gris:** con la nube naranja, Cloudflare se pone en medio y
> GitHub no puede crear el certificado HTTPS (el candado). Además, con el modo SSL
> "Flexible" de Cloudflare la web entra en un bucle de redirecciones. En gris todo
> funciona a la primera; más adelante se puede activar la naranja con SSL
> **Full (strict)** si algún día interesa, pero no hace falta.

Opcional y gratis en el mismo panel:
- **DNSSEC** (menú DNS → Settings → Enable DNSSEC): protege el dominio contra
  suplantaciones.
- **Email Routing**: un correo `contacto@pokesurvivor.xyz` que te llegue a tu Gmail,
  si quieres un correo con el nombre del juego.

Cuando lo tengas, dime **"ya está el DNS"** y compruebo que se ve bien desde fuera
(suele tardar de 5 minutos a 1 hora).

## Paso 2 · Verificar el dominio en GitHub (TÚ, recomendado, 3 minutos)

Protege el dominio: impide que otra cuenta de GitHub pueda usar pokesurvivor.xyz.

1. Entra en <https://github.com/settings/pages> (con la cuenta JPTER78).
2. **Add a domain** → escribe `pokesurvivor.xyz` → **Add domain**.
3. GitHub te enseña un registro **TXT**: un nombre del estilo
   `_github-pages-challenge-JPTER78` y un valor largo.
4. En Cloudflare → DNS → Records → **Add record**: Type **TXT**, Name el que te dio
   GitHub (sin `.pokesurvivor.xyz` al final), Content el valor largo.
5. Vuelve a GitHub y pulsa **Verify**. Si dice que no, espera unos minutos y repite.

## Paso 3 · Paso final (YO)

Cuando el DNS funcione, lo hago todo yo:

1. `bash tools/activar_dominio.sh`: compila el juego con el SEO, regenera las
   páginas, crea el archivo `CNAME` y prepara el commit (comprueba que no se cuela
   ningún dato privado).
2. Lo subo a GitHub y en GitHub Pages pongo el dominio `pokesurvivor.xyz`.
3. Espero a que GitHub cree el certificado y activo **Enforce HTTPS**.
4. Compruebo en un navegador real: la web, `www.` → sin `www`, la dirección vieja
   de github.io → la nueva, el inglés en `/en/`, entrar con cuenta y con Google,
   el ranking y el cooperativo.
5. Pongo `https://pokesurvivor.xyz` como web del repositorio de GitHub.

**Ojo con las partidas de invitado:** se guardan en el navegador y van ligadas a la
dirección. Quien juegue como invitado en `jpter78.github.io` no verá esa partida en
`pokesurvivor.xyz` (las cuentas registradas sí, porque están en la nube). Si alguien
te lo pregunta: que cree una cuenta antes del cambio.

## Paso 4 · Google Search Console y Bing (TÚ, después del paso 3)

1. <https://search.google.com/search-console> → **Añadir propiedad** →
   **Dominio** → `pokesurvivor.xyz`.
2. Como el dominio está en Cloudflare, Google ofrece **verificar con Cloudflare**
   automáticamente: acepta y listo (si no, te da un TXT para ponerlo como en el
   paso 2).
3. Menú **Sitemaps** → escribe `sitemap.xml` → **Enviar**.
4. Menú **Inspección de URL** → `https://pokesurvivor.xyz/` → **Solicitar
   indexación**. Repite con `https://pokesurvivor.xyz/en/`,
   `https://pokesurvivor.xyz/guia/` y `https://pokesurvivor.xyz/pokedex/`.
5. Bing (y con él DuckDuckGo y Ecosia): <https://www.bing.com/webmasters> →
   **Importar desde Google Search Console**.

Google tarda de unos días a un par de semanas en empezar a enseñar la web.

## Después

- Cambia el enlace en la descripción del tráiler de YouTube, en Ko-fi y donde lo
  hayas compartido.
- Lo que más ayuda a posicionar a partir de aquí está en [SEO.md](SEO.md),
  apartado 3 (enlaces desde YouTube, itch.io, Reddit, Discord...).
