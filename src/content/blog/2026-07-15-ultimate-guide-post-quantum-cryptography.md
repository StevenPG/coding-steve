---
author: StevenPG
pubDatetime: 2026-07-15T12:00:00.000Z
title: "The Ultimate Guide to Post-Quantum Cryptography and TLS 1.3"
slug: ultimate-guide-post-quantum-cryptography-tls
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - security
  - tls
  - cryptography
  - post-quantum
  - java
description: Over half the web's TLS handshakes are already post-quantum and almost nobody noticed. How ML-KEM hybrid key exchange works in TLS 1.3, what "harvest now, decrypt later" actually means, why certificates are the unsolved half, why your database at rest was never the problem, and where the JVM stands with JEP 496 and JEP 527.
---

# The Ultimate Guide to Post-Quantum Cryptography and TLS 1.3

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how things work. Post-quantum cryptography is a topic that badly needs that treatment, because the public conversation about it is split between two equally useless extremes: breathless "quantum computers will break the internet" headlines, and academic papers full of module lattices and ring polynomials.

Here's the thing that got me interested enough to write this: **as of mid-2026, more than half of all human-generated web traffic is already encrypted with post-quantum cryptography**, and almost nobody noticed. If you loaded this page in a recent Chrome, Firefox, or Safari, your browser and Cloudflare just performed a post-quantum key exchange to deliver it. You've been using PQC for months, maybe years, without doing anything.

At the same time, another chunk of the post-quantum story — certificates, signatures, the stuff that proves a server is who it says it is — has barely started, and that's *by design*, not negligence.

This guide covers the whole landscape:

- What quantum computers actually break (and what they don't)
- Why "harvest now, decrypt later" made key exchange the urgent problem
- How the hybrid `X25519MLKEM768` key exchange in TLS 1.3 actually works
- How to verify post-quantum TLS on your own connections with DevTools, `openssl`, and `curl`
- Why certificates and signatures are deliberately lagging behind
- Why your data at rest mostly *doesn't* need post-quantum crypto
- Where the JVM stands: JEP 496, JEP 497, JEP 527, and what a Spring Boot service behind Cloudflare actually needs to do (spoiler: for the front door, nothing)
- The NIST deadlines that turn all of this from "interesting" into "planned work"

No lattice math required. Some light Java along the way.

## The Threat Model: What Quantum Computers Actually Break

To make sense of any of this, you need one piece of mental furniture: quantum computers do not break "encryption." They break *specific mathematical problems*, and modern cryptography is built on several different ones.

### Shor's algorithm: the extinction event for public-key crypto

In 1994, Peter Shor published a quantum algorithm that solves integer factorization and discrete logarithms in polynomial time. Those two problems are the entire security foundation of:

- **RSA** (factoring)
- **Diffie-Hellman and ECDH key exchange** (discrete logs)
- **ECDSA / EdDSA signatures** (discrete logs)

That's essentially every public-key algorithm deployed on the internet before 2024. Against a sufficiently large, error-corrected quantum computer — usually called a **CRQC** (cryptographically relevant quantum computer) — these algorithms don't get weaker. They get *completely broken*. Not "upgrade your key size" broken; "the math no longer provides any security" broken.

No CRQC exists today. Current machines are orders of magnitude away from the millions of stable qubits needed. Estimates for when one might exist range from the 2030s to "never," but governments and standards bodies are planning around the 2030–2035 window, and as we'll see, for some data the arrival date almost doesn't matter.

### Grover's algorithm: a haircut for symmetric crypto

The other famous quantum algorithm, Grover's search (1996), affects symmetric ciphers like AES and hash functions like SHA-256. But its impact is dramatically milder: it provides a *quadratic* speedup for brute-force search, which effectively **halves the security level**. AES-256 drops to roughly 128 bits of effective security against a quantum attacker.

128 bits is still completely infeasible to brute-force. This is the single most under-appreciated fact in the whole topic:

> **Symmetric cryptography is already post-quantum.** AES-256 and SHA-384 survive the quantum era just fine. The crisis is exclusively in public-key cryptography — key exchange and signatures.

Keep that in your pocket; it's the key to the "at rest" section later.

### The replacements: FIPS 203, 204, 205

NIST ran an eight-year public competition to standardize quantum-resistant replacements, and in **August 2024** finalized three standards:

| Standard | Algorithm | Formerly known as | Job |
|---|---|---|---|
| **FIPS 203** | ML-KEM | CRYSTALS-Kyber | Key encapsulation (replaces ECDH/RSA key exchange) |
| **FIPS 204** | ML-DSA | CRYSTALS-Dilithium | Digital signatures (replaces RSA/ECDSA) |
| **FIPS 205** | SLH-DSA | SPHINCS+ | Stateless hash-based signatures (conservative backup) |

The "ML" stands for *module-lattice* — both ML-KEM and ML-DSA are built on lattice problems that, as far as decades of cryptanalysis can tell, are hard for classical *and* quantum computers. ML-KEM is the star of this article; it's what's securing your browser traffic right now.

## Harvest Now, Decrypt Later

Here's the question that should be nagging you: if no quantum computer capable of breaking RSA exists, and one might be a decade or more away, why did the entire industry sprint to deploy ML-KEM in 2024–2026?

The answer is the threat model with the best name in security: **harvest now, decrypt later** (HNDL).

TLS traffic can be passively recorded. An adversary — think nation-state intelligence agencies with taps on internet backbones — can capture your encrypted traffic *today* and simply store it. Storage is cheap. When a CRQC eventually exists, they replay the recorded handshakes, use Shor's algorithm to break the ECDH key exchange, recover the session keys, and decrypt everything they captured. Retroactively.

This means the relevant question is not "when will quantum computers arrive?" It's:

> **How long does your data need to stay secret, plus how long will migration take, versus when a CRQC arrives?**

(This framing is known as Mosca's theorem.) Medical records, financial data, diplomatic cables, trade secrets, journalists' sources — plenty of data transmitted in 2026 still needs to be confidential in 2040. For that data, every classically-encrypted TLS session is *already* compromised in slow motion if anyone bothered to record it.

This is also why the industry fixed things in the order it did:

- **Key exchange (confidentiality)**: broken *retroactively* by a future CRQC. Had to be fixed immediately. ✅ Largely done.
- **Signatures (authentication)**: a future quantum computer cannot travel back in time and forge a handshake that already happened. Signatures only need replacing *before* CRQCs actually exist. ⏳ Deliberately deferred.

If you only remember one distinction from this article, make it that one. It explains the entire deployment landscape.

## TLS 1.3 in Sixty Seconds: Two Jobs, Two Problems

A TLS 1.3 handshake does two cryptographically distinct jobs, and post-quantum migration treats them completely differently, so it's worth being precise.

**Job 1 — Key agreement (confidentiality).** Client and server agree on a shared secret over an untrusted network. In classical TLS 1.3 this is ephemeral elliptic-curve Diffie-Hellman: the client sends a key share in its `ClientHello`, the server responds with its own in the `ServerHello`, and both sides derive the same secret. That secret feeds a key schedule (HKDF) that produces the symmetric AES keys protecting all application data.

**Job 2 — Authentication (identity).** The server proves it's actually `stevenpg.com` and not an impostor. It presents a certificate chain and produces a digital signature (`CertificateVerify`) over the handshake transcript using the private key matching its certificate. Your browser validates the chain up to a trusted root CA.

Both jobs use quantum-vulnerable math today... but only Job 1 is vulnerable to *recorded* traffic. Job 2's signatures are only useful to an attacker in real time, during an active man-in-the-middle. So:

- **Job 1** is where ML-KEM has already been deployed at scale.
- **Job 2** is where ML-DSA is standardized, tested, and sitting on the bench waiting for the ecosystem (more on that later).

Everything after the handshake — the actual data — is AES, which we've established doesn't have a quantum problem.

## What's a KEM, and Why Isn't It Just Diffie-Hellman?

ML-KEM is a **Key Encapsulation Mechanism**, which is a subtly different shape of primitive than Diffie-Hellman, and the difference trips people up.

Diffie-Hellman is symmetric in structure: both parties contribute a key share, and the shared secret is a *function of both contributions*. Neither side chooses it.

A KEM is asymmetric in structure, more like tiny single-use RSA encryption:

1. **KeyGen**: Alice generates an ephemeral keypair and sends Bob the public ("encapsulation") key.
2. **Encapsulate**: Bob feeds Alice's public key into the encapsulation function. It generates a random shared secret *and* a ciphertext that encrypts/encapsulates it. Bob sends back only the ciphertext.
3. **Decapsulate**: Alice uses her private key to recover the same shared secret from the ciphertext.

Both sides now hold the same secret; an eavesdropper saw only the public key and the ciphertext, and recovering the secret from those requires solving the underlying lattice problem.

The nice part is that this maps perfectly onto TLS 1.3's existing message flow: the client's `ClientHello` key share carries the encapsulation key, and the server's `ServerHello` key share carries the ciphertext. No new round trips, no protocol redesign — which is a big part of why deployment went so fast.

The costs are size and a design quirk:

- An ML-KEM-768 encapsulation key is **1,184 bytes** and the ciphertext is **1,088 bytes**. Compare X25519's 32-byte shares. Your `ClientHello` gets about 1.2 KB heavier — noticeable, occasionally packet-splitting, but tolerable.
- KEM secrets are chosen by the encapsulating side rather than mutually derived, which required some careful protocol analysis, and it's one reason nobody wanted to bet the internet on ML-KEM *alone*. Which brings us to hybrids.

## X25519MLKEM768: The Hybrid Handshake Securing Half the Web

The thing actually deployed everywhere is not raw ML-KEM. It's a **hybrid** named group called `X25519MLKEM768` (TLS codepoint `0x11EC`, defined in the IETF's hybrid key exchange design for TLS 1.3), and the concept is beautifully simple:

**Do both key exchanges, and mix both secrets into the key schedule.**

Concretely, within the single existing round trip:

1. The client's key share contains an X25519 public key **and** an ML-KEM-768 encapsulation key.
2. The server's key share contains an X25519 public key **and** an ML-KEM-768 ciphertext.
3. Both sides compute the X25519 shared secret and the ML-KEM shared secret, concatenate them, and feed the combined value into TLS 1.3's HKDF-based key schedule.

Because of how HKDF works, the derived session keys are secure **as long as either input secret is secure**. To decrypt the session, an attacker must break X25519 *and* ML-KEM-768:

- A future quantum computer breaks the X25519 half — but ML-KEM holds.
- If cryptanalysts find a devastating flaw in the young lattice math — X25519, with 25+ years of scrutiny, holds.

This is belt *and* suspenders, and it's why conservative security teams were willing to deploy a brand-new primitive at internet scale: the hybrid can't be *less* secure than the classical crypto it replaced. The practical costs are the ~2.3 KB of extra handshake bytes and a few microseconds of lattice math — ML-KEM operations are actually *fast*, competitive with or faster than X25519 itself. Cloudflare and Chrome both measured the real-world latency impact and found it small enough to enable for everyone by default.

The naming, for the record, follows the algorithms in the order the bytes appear on the wire: `X25519MLKEM768` = X25519 share first, ML-KEM-768 second. You'll also see `SecP256r1MLKEM768` and `SecP384r1MLKEM1024` for NIST-curve variants, but the X25519 hybrid is the internet's de facto standard.

## The Quiet Rollout: How Half the Web Went Post-Quantum

Now, your actual question: is "all of Cloudflare" really using this? Close enough that the distinction barely matters, on the browser-facing side.

The timeline of the quiet rollout:

- **2022–2023**: Cloudflare and Google run large-scale experiments with a pre-standard Kyber hybrid (`X25519Kyber768Draft00`).
- **April 2024**: Chrome 124 enables the Kyber hybrid *by default* on desktop. This is the moment PQC hits mainstream traffic.
- **August 2024**: NIST finalizes FIPS 203; the ecosystem migrates from draft-Kyber to final ML-KEM.
- **Late 2024**: Chrome 131 switches to the standardized `X25519MLKEM768`; Firefox 132+ enables it. Cloudflare supports it across the entire network.
- **2025**: [OpenSSL 3.5](https://openssl-corporation.org/post-quantum.html) ships ML-KEM with the hybrid *enabled by default*; Go 1.24 enables `X25519MLKEM768` by default in `crypto/tls`; Cloudflare [upgrades ~6 million origin-facing domains automatically](https://blog.cloudflare.com/automatically-secure/).
- **2026**: Apple ships system-wide support in iOS 26 / macOS Tahoe 26, bringing Safari fully into the fold. Per [Cloudflare's own measurements](https://blog.cloudflare.com/pq-2025/), post-quantum key agreement crosses **50% of all web requests** — [54% by Q2 2026](https://postquantum.com/industry-news/cloudflare-pqc-majority-traffic/), roughly double the year before.

So when you read "all of Cloudflare uses post-quantum," what it precisely means is: **Cloudflare's edge supports and prefers `X25519MLKEM768` on every site it fronts, and every major browser now offers it by default** — so the browser↔edge leg of most connections negotiates it automatically. The remaining ~46% is mostly older clients, embedded devices, and API traffic from TLS stacks that haven't caught up.

There's a much less rosy second number, though, and it matters if you run backend services: on the **edge→origin** leg — Cloudflare connecting to *your* server — post-quantum support was only around **10% in Q2 2026**. The browser-facing internet went post-quantum because a handful of big edges and browser vendors flipped defaults for everyone. The origin-facing internet requires millions of individual operators to upgrade their own TLS stacks, and that long tail moves slowly. If your Spring Boot service sits behind Cloudflare, the user→Cloudflare hop is almost certainly post-quantum today, and the Cloudflare→origin hop almost certainly is not, unless you've done something about it. We'll fix that in the JVM section.

## See It Yourself

Reading about it is one thing; watching your own laptop do a post-quantum handshake is much more satisfying. Three ways, in increasing nerdiness.

### 1. Your browser, right now

Open Chrome DevTools (F12) on any Cloudflare-fronted site — this one works — and check the **Security** panel. The connection details will read something like:

```
The connection to this site is encrypted and authenticated using TLS 1.3,
X25519MLKEM768, and AES_128_GCM.
```

That middle term is the hybrid post-quantum key exchange. Firefox shows the equivalent under the padlock → Connection Secure → More Information. Cloudflare also runs a dedicated test page at [pq.cloudflareresearch.com](https://pq.cloudflareresearch.com/) that tells you in plain English whether your connection used post-quantum key agreement.

Notice what the line *also* says: authenticated with a classical certificate (ECDSA or RSA — check the certificate details), encrypted with AES. One connection, three algorithms, three completely different quantum stories. That single DevTools line is this entire article in miniature.

### 2. openssl s_client

With OpenSSL 3.5+ (where ML-KEM support landed):

```sh
openssl s_client -connect cloudflare.com:443 -groups X25519MLKEM768 -brief
```

```
CONNECTION ESTABLISHED
Protocol version: TLSv1.3
Ciphersuite: TLS_AES_256_GCM_SHA384
...
Negotiated TLS1.3 group: X25519MLKEM768
```

The `-groups X25519MLKEM768` flag restricts the client to offering *only* the hybrid, so a successful handshake is proof the server supports it. Drop the flag and OpenSSL 3.5 will offer the hybrid by default anyway — try it against your own servers and see what they negotiate. (`openssl version` first; distro-packaged 3.0.x won't know the group. Check your `openssl version` output before concluding a server lacks support.)

### 3. curl

curl built against OpenSSL 3.5+ exposes the same knob:

```sh
curl -v --curves X25519MLKEM768 https://www.cloudflare.com -o /dev/null 2>&1 | grep -E "SSL connection|handshake"
```

```
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384 / X25519MLKEM768 / id-ecPublicKey
```

Same story in one line: post-quantum key exchange (`X25519MLKEM768`), classical authentication (`id-ecPublicKey` — an ECDSA certificate), quantum-fine symmetric encryption (`AES_256_GCM`).

## The Unsolved Half: Certificates and Signatures

So key exchange is done. What about that certificate still authenticating with ECDSA? This is the part of your question about "the other post-quantum thing that isn't widely used" — and it's almost certainly this, not at-rest encryption.

ML-DSA (FIPS 204) has been a finished standard since August 2024. Nobody's TLS certificates use it. Three reasons:

**1. The urgency asymmetry.** As covered earlier, signatures can't be broken retroactively. A CRQC in 2035 cannot forge a handshake that happened in 2026 — the handshake is over; its transcript signature already served its purpose. Signatures must be replaced *before* CRQCs exist, not before traffic is recorded. The industry is spending its urgency budget where the retroactive risk is.

**2. The size problem is brutal.** An ECDSA P-256 signature is 64–72 bytes with a 65-byte public key. ML-DSA-65 — the middle parameter set — has **1,952-byte public keys and 3,309-byte signatures**. A TLS handshake carries several signatures and public keys: the CertificateVerify signature, the leaf certificate's key and its CA signature, intermediate certificates, SCTs for Certificate Transparency, OCSP staples. Convert the whole chain to ML-DSA and you're adding roughly **9–15 KB** to every handshake. That blows through TCP initial congestion windows, adds round trips, and measurably breaks some middleboxes and embedded TLS implementations. Experiments (Cloudflare, Google, and [academic studies](https://arxiv.org/pdf/2604.06100)) show it's *survivable* but painful, and various mitigation schemes (suppressing intermediates, Merkle tree certificates) are being actively designed at the IETF.

**3. The ecosystem dependency chain.** Publicly-trusted PQ certificates need: IETF-finalized X.509 encodings for ML-DSA → CA/Browser Forum Baseline Requirements allowing them → CAs issuing them → browsers trusting them. That machinery is [grinding through 2026–2027](https://comparecheapssl.com/post-quantum-ssl-certificates-what-website-owners-need-to-know/). Meanwhile, **private PKI** — where you control both ends and answer to no browser forum — is where PQ signatures actually work today: AWS Private CA has offered ML-DSA certificates since late 2025, DigiCert's private CA products support them, and OpenSSL 3.5 can mint them locally if you want to play.

The 10,000-foot status: **key exchange shipped, signatures are in the lab**. If a vendor tries to sell you "full post-quantum TLS" today, the certificate half of that claim deserves scrutiny.

## What About Data At Rest?

Time for the most common misconception in this space, and the other half of your original question. You'd think data sitting in a database for 20 years is *more* exposed to future quantum computers than a TLS session, right? Mostly, no — and the reason is that fact we pocketed earlier.

**Data at rest is encrypted with symmetric cryptography.** Your encrypted EBS volumes, LUKS disks, encrypted S3 buckets, database TDE — it's all AES-256. Grover's algorithm reduces that to ~128-bit effective security, which remains unbreakable by any physically plausible computer, quantum or otherwise. There is no Shor's algorithm for AES. Your database was never the problem; your recorded TLS handshakes were, because *they* used quantum-breakable public-key math to establish their keys.

So why does "post-quantum at rest" exist as a topic at all? Because of the public-key crypto *wrapped around* the symmetric keys:

- **Envelope encryption / KMS**: your AES data keys are often themselves encrypted ("wrapped") under a master key. If that wrapping uses RSA — as some KMS import paths and HSM schemes do — the wrap is quantum-vulnerable, and a stolen ciphertext-plus-wrapped-key bundle becomes HNDL-exposed. Wrapping with AES (as most cloud KMS defaults do) is already fine; the fix elsewhere is ML-KEM-based key wrapping (HPKE with ML-KEM), which cloud providers are rolling out.
- **PGP/age-style file encryption**: encrypting a backup "to a public key" uses RSA or ECDH under the hood — same retroactive exposure if the ciphertext leaks. Post-quantum modes for these tools exist but are young; this is genuinely the "not widely used" territory.
- **Signed artifacts with long lifetimes**: firmware images, software update signatures, legal documents — signatures that must remain *verifiable and unforgeable* decades from now. This is where SLH-DSA and ML-DSA at rest actually matter, and where standards bodies are pushing hardest (hash-based signatures are already common in secure-boot chains for exactly this reason).

The honest summary for a working engineer: **at rest, check what's wrapping your keys and what's signing your artifacts — the bulk encryption itself is already quantum-safe.** It's a targeted audit, not a migration.

## Post-Quantum on the JVM

Time to bring this home to the stack this blog usually lives on. Where does Java actually stand? Better than you'd expect, with one big caveat about timing.

### The primitives: JEP 496 and JEP 497 (JDK 24)

JDK 24 (March 2025) delivered both NIST algorithms as standard JCA algorithms — no BouncyCastle required:

- [JEP 496](https://openjdk.org/jeps/496): **ML-KEM** (FIPS 203) — `KeyPairGenerator`/`KEM` algorithms `ML-KEM-512`, `ML-KEM-768`, `ML-KEM-1024`
- [JEP 497](https://openjdk.org/jeps/497): **ML-DSA** (FIPS 204) — `KeyPairGenerator`/`Signature` algorithms `ML-DSA-44`, `ML-DSA-65`, `ML-DSA-87`

ML-KEM plugs into the `javax.crypto.KEM` API that arrived back in JDK 21 (JEP 452). Here's the entire encapsulate/decapsulate dance — this is a complete, runnable demystification of what a KEM is, in about 20 lines:

```java
import javax.crypto.KEM;
import javax.crypto.SecretKey;
import java.security.*;
import java.util.HexFormat;

/// Runs on JDK 24+, no dependencies. This is (conceptually) what your
/// browser and Cloudflare do inside every TLS handshake.
public class MlKemDemo {
    public static void main(String[] args) throws Exception {
        // ALICE (think: TLS client): generate an ephemeral ML-KEM keypair.
        // The public key is the 1,184-byte "encapsulation key" that rides
        // in the ClientHello.
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("ML-KEM-768");
        KeyPair alice = kpg.generateKeyPair();

        // BOB (think: TLS server): encapsulate against Alice's public key.
        // This single call generates a random shared secret AND the
        // 1,088-byte ciphertext that carries it back in the ServerHello.
        KEM kem = KEM.getInstance("ML-KEM");
        KEM.Encapsulated enc = kem.newEncapsulator(alice.getPublic()).encapsulate();
        SecretKey bobsSecret = enc.key();
        byte[] ciphertext = enc.encapsulation();

        // ALICE: decapsulate the ciphertext with her private key.
        SecretKey alicesSecret = kem.newDecapsulator(alice.getPrivate())
                .decapsulate(ciphertext);

        // Same 32-byte secret on both sides; the wire saw only the public
        // key and the ciphertext. In TLS this secret gets concatenated
        // with the X25519 secret and fed into the HKDF key schedule.
        System.out.println("bob:   " + HexFormat.of().formatHex(bobsSecret.getEncoded()));
        System.out.println("alice: " + HexFormat.of().formatHex(alicesSecret.getEncoded()));
    }
}
```

Note what's *not* here compared to Diffie-Hellman: Bob never generates a keypair. He receives a public key, produces a secret plus ciphertext in one shot, and is done. That asymmetry is the KEM shape.

### The missing piece: JEP 527 (JDK 27, September 2026)

Here's the caveat: having ML-KEM in the JCA is not the same as *using it in TLS*. Through JDK 26, the built-in TLS provider (JSSE) doesn't offer the hybrid named groups — a plain `HttpClient` or `RestClient` call from JDK 25 negotiates classical X25519, full stop. Your Java services are part of that ~90% of origin traffic that isn't post-quantum yet.

[JEP 527](https://openjdk.org/jeps/527) — *Post-Quantum Hybrid Key Exchange for TLS 1.3* — closes the gap, adding `X25519MLKEM768`, `SecP256r1MLKEM768`, and `SecP384r1MLKEM1024` as TLS named groups. It's [targeted to JDK 27](https://openjdk.org/projects/jdk/27/), GA September 2026 (in rampdown as I write this — you can try early-access builds today). Once you're on JDK 27, verifying is a one-liner against any Cloudflare site:

```java
import javax.net.ssl.*;

public class PqTlsCheck {
    public static void main(String[] args) throws Exception {
        // Offer ONLY the hybrid group; if the handshake succeeds, the
        // server did post-quantum key agreement with us.
        System.setProperty("jdk.tls.namedGroups", "X25519MLKEM768");

        var factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
        try (var socket = (SSLSocket) factory.createSocket("www.cloudflare.com", 443)) {
            socket.startHandshake();
            var session = socket.getSession();
            System.out.println(session.getProtocol() + " / " + session.getCipherSuite()
                    + " — handshake OK, key exchange was post-quantum");
        }
    }
}
```

If you can't wait for JDK 27 (or are stuck on an older LTS), the practical options today are BouncyCastle's JSSE provider, which has shipped the hybrid groups for a while, or — much more commonly — simply not terminating TLS in the JVM at all.

### What your Spring Boot service actually needs to do

Let's make this concrete with the deployment this blog's readers most likely run: a Spring Boot app behind Cloudflare (or another PQ-capable edge/load balancer).

**The front door: nothing.** Cloudflare terminates the browser's TLS at the edge. The user↔Cloudflare hop negotiates `X25519MLKEM768` with zero involvement from your application. Your users already have post-quantum protection against harvest-now-decrypt-later on the public internet leg, and you did literally nothing. This is the pleasant consequence of PQC being deployed at the *protocol* layer — applications above TLS are untouched.

**The back door: one decision.** The Cloudflare→origin hop is the under-10% leg. Your realistic options, in order of effort:

1. **Terminate origin TLS in a proxy, not the JVM.** If nginx, HAProxy, Caddy, or Envoy fronts your Spring Boot app, upgrading *that* to a build linked against OpenSSL 3.5+ gets you hybrid key exchange on the origin hop today — Cloudflare will negotiate it automatically. Your JVM keeps speaking plain HTTP (or classical TLS) inside the private network. This is the 90% answer.
2. **Wait for JDK 27** if your JVM terminates TLS directly (embedded Tomcat/Netty with an exposed HTTPS port). Come September 2026 it's a JDK upgrade plus, at most, a `jdk.tls.namedGroups` tweak — the JEP enables the hybrids by default in a sensible preference order.
3. **BouncyCastle JSSE now**, if you have a compliance mandate that can't wait. It works, but it's a dependency and configuration you'll be un-doing after JDK 27.

And your service-to-service traffic *inside* the cluster? Same logic as everywhere else: if it's mTLS through a mesh sidecar (Envoy/Istio), the mesh's TLS library decides, and those are picking up OpenSSL/BoringSSL PQ support on their own upgrade trains. Data that never leaves your VPC has a milder HNDL exposure than public-internet traffic, so it's reasonable to let it ride the default upgrade wave rather than force it.

## The Timeline: When "Optional" Becomes "Mandatory"

If the harvest-now argument doesn't move your organization, the compliance calendar will. NIST's transition guidance ([NIST IR 8547](https://nvlpubs.nist.gov/nistpubs/ir/2024/NIST.IR.8547.ipd.pdf)) puts hard dates on the classical algorithms:

- **2030**: RSA, ECDSA, ECDH, DSA, and finite-field DH at the ~112-bit level are **deprecated** — continued use requires documented risk acceptance.
- **2035**: they are **disallowed** entirely in NIST-regulated contexts. No waivers.

The NSA's CNSA 2.0 timeline for national-security systems is even more aggressive, requiring PQ across the board by 2033 with browsers/servers expected much sooner. If you sell to the US government or operate in regulated finance/healthcare, "post-quantum migration" stopped being a research topic and became a project with a deadline. Nine years sounds like a lot until you remember how long the TLS 1.0 → 1.2 migration took (SHA-1 deprecation alone was a decade of pain), and that this one touches *every keypair you own*.

The good news this article should have made clear: for TLS key exchange specifically, the ecosystem did the migration *for* you. The signature/PKI migration is the one that will consume the 2027–2033 window.

## Practical Checklist

The whole guide as actionable items:

- **Verify your public sites** negotiate `X25519MLKEM768` (DevTools Security tab, or `openssl s_client -groups X25519MLKEM768`). Behind Cloudflare/major CDNs: almost certainly already ✅.
- **Check the edge→origin hop** — it's probably classical. Upgrade your origin proxy to OpenSSL 3.5+ or plan the JDK 27 upgrade if the JVM terminates TLS.
- **Don't buy "post-quantum certificates"** for public sites yet — the trust ecosystem isn't ready. Do watch this space for 2027.
- **For private PKI with long-lived trust needs**, ML-DSA is available today (AWS Private CA, OpenSSL 3.5) and worth piloting.
- **At rest**: audit the *public-key* layers only — KMS key-wrapping algorithms, PGP/age-style backup encryption, artifact signing lifetimes. Your AES-256 bulk encryption is already quantum-resistant.
- **Inventory your crypto** (NIST calls this a Cryptographic Bill of Materials). The 2030/2035 dates apply to every keypair, not just TLS.
- **On the JVM**: JDK 24+ gives you ML-KEM/ML-DSA primitives; JDK 27 (September 2026) gives you post-quantum TLS. Put the JDK 27 upgrade on the roadmap with a security justification attached.
- **Ignore quantum panic marketing.** The threat is real but specific: public-key crypto, and especially recorded key exchanges. Anyone selling quantum-proof AES replacements or "quantum encryption" for your database is selling you the part that was never broken.

## Wrapping Up

The post-quantum story in 2026 is genuinely one of the internet's better security migrations, and it's worth appreciating the shape of it. The industry identified that the two halves of TLS have completely different quantum risk profiles — key exchange is retroactively breakable via harvest-now-decrypt-later, signatures are not — and spent its urgency accordingly. The result: hybrid ML-KEM key agreement went from NIST standard to majority of web traffic in under two years, deployed so smoothly through browser and CDN defaults that most engineers never noticed, while the messier certificate migration proceeds at the deliberate pace it can afford.

For your own systems, the summary is short. Your users' connections to your Cloudflare-fronted sites are already post-quantum. Your origin and service-to-service hops probably aren't, and closing that is an OpenSSL 3.5 proxy upgrade today or a JDK 27 upgrade in September. Your data at rest never needed rescuing — but the public keys wrapping and signing things might. And the 2030 deprecation clock means "eventually" now has a date on it.

The next milestone to watch is post-quantum authentication: IETF certificate formats, CA/Browser Forum rules, and the handshake-size engineering (Merkle tree certificates are the interesting one) needed to make 3 KB signatures livable. When that lands, there'll be a follow-up post.

### References

- [Cloudflare — The state of the post-quantum Internet in 2025](https://blog.cloudflare.com/pq-2025/) and [PQC docs](https://developers.cloudflare.com/ssl/post-quantum-cryptography/)
- [Cloudflare — Automatically Secure: upgrading 6M domains](https://blog.cloudflare.com/automatically-secure/) and [PQC to origin servers](https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-to-origin/)
- [Cloudflare's post-quantum browser check](https://pq.cloudflareresearch.com/)
- [JEP 496: ML-KEM](https://openjdk.org/jeps/496), [JEP 497: ML-DSA](https://openjdk.org/jeps/497), [JEP 527: Post-Quantum Hybrid Key Exchange for TLS 1.3](https://openjdk.org/jeps/527)
- [OpenSSL post-quantum readiness](https://openssl-corporation.org/post-quantum.html)
- [NIST IR 8547 — Transition to Post-Quantum Cryptography Standards](https://nvlpubs.nist.gov/nistpubs/ir/2024/NIST.IR.8547.ipd.pdf)
- NIST [FIPS 203 (ML-KEM)](https://csrc.nist.gov/pubs/fips/203/final), [FIPS 204 (ML-DSA)](https://csrc.nist.gov/pubs/fips/204/final), [FIPS 205 (SLH-DSA)](https://csrc.nist.gov/pubs/fips/205/final)
- [Signature placement in post-quantum TLS certificate hierarchies (arXiv)](https://arxiv.org/pdf/2604.06100)

If you found this useful, the other deep-dives in this format — the [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration), the [gRPC guide](/posts/ultimate-guide-spring-grpc), and the [Spring Boot Actuator guide](/posts/ultimate-guide-spring-boot-actuator) — cover their topics the same way.
