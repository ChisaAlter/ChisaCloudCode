# Feature Specification: Global Job Dashboard

**Feature Branch**: `002-global-job-dashboard`  
**Created**: 2026-04-26  
**Status**: Draft  
**Input**: User description: "Pour la V0.2.0, je veux un tableau de bord global (tout projets confondus) permettant de visualiser le statut de tous les jobs."

## Clarifications

### Session 2026-04-27

- Q: Quel doit etre le point d'acces principal au tableau de bord global ? → A: Un onglet global dedie, separe des vues par workspace.
- Q: La vue globale doit-elle permettre des actions directes sur les jobs ? → A: Oui, elle doit autoriser des actions directes sur chaque job depuis la vue globale.
- Q: Quelles actions directes doivent etre autorisees depuis la vue globale ? → A: Run Now, Pause, Resume et Retry.
- Q: Quel mode de rafraichissement doit utiliser le tableau de bord global ? → A: Rafraichissement automatique periodique avec bouton de rafraichissement manuel.
- Q: Comment traiter les jobs dont le workspace n'est plus lisible ou a ete deplace ? → A: Les conserver visibles avec un statut explicite de workspace indisponible ou partiel.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View global job status (Priority: P1)

Un utilisateur ouvre un tableau de bord global et voit immédiatement l'etat de tous les jobs planifies, tous workspaces confondus, sans devoir ouvrir chaque projet un par un.

**Why this priority**: C'est la valeur principale de la V0.2.0. Sans cette vue consolidee, l'utilisateur doit encore naviguer workspace par workspace pour comprendre son parc de jobs.

**Independent Test**: Peut etre teste en configurant plusieurs workspaces avec des jobs dans des etats differents, puis en verifiant qu'une vue unique les affiche tous avec leur workspace, leur prochain run et leur dernier statut.

**Acceptance Scenarios**:

1. **Given** plusieurs workspaces contiennent des jobs planifies, **When** l'utilisateur ouvre le tableau de bord global, **Then** il voit tous les jobs agreges dans une seule vue avec leur nom, leur workspace, leur etat et leur prochaine execution.
2. **Given** certains jobs sont en echec, rates ou pauses, **When** l'utilisateur consulte le tableau de bord global, **Then** ces jobs sont identifies visuellement sans que l'utilisateur doive ouvrir leur workspace d'origine.
3. **Given** le tableau de bord global est deja ouvert, **When** l'etat d'un job change ou qu'une nouvelle execution survient, **Then** la vue se met a jour automatiquement dans le cycle de rafraichissement prevu et l'utilisateur peut aussi demander un rafraichissement manuel.

---

### User Story 2 - Spot operational problems quickly (Priority: P2)

Un utilisateur veut identifier rapidement les jobs qui demandent une action, par exemple les jobs en echec, rates, pauses ou sans prochaine execution valide.

**Why this priority**: Une vue globale a peu d'utilite si les problemes ne ressortent pas clairement. Cette histoire transforme la vue consolidee en outil de supervision.

**Independent Test**: Peut etre teste en creant un melange de jobs sains et problematiques, puis en verifiant que le tableau de bord permet de filtrer ou mettre en avant les jobs qui necessitent une action.

**Acceptance Scenarios**:

1. **Given** le systeme contient a la fois des jobs sains et des jobs problematiques, **When** l'utilisateur affiche le tableau de bord global, **Then** les jobs qui demandent une action sont clairement distinguables.
2. **Given** l'utilisateur veut ne voir que les jobs problematiques, **When** il applique un filtre de statut, **Then** la vue ne montre que les jobs correspondant au filtre selectionne.

---

### User Story 3 - Navigate from global overview to workspace context (Priority: P3)

Un utilisateur repere un job dans la vue globale puis veut soit agir directement dessus, soit retrouver rapidement son contexte de workspace pour poursuivre l'investigation ou l'action dans la vue existante du plugin.

**Why this priority**: La vue globale doit rester compatible avec l'architecture actuelle du produit tout en devenant une vraie console de pilotage. Elle sert d'entree centralisee et doit reduire au maximum les navigations inutiles.

**Independent Test**: Peut etre teste en selectionnant un job depuis la vue globale, en declenchant une action directe sur ce job, puis en verifiant que l'utilisateur peut aussi ouvrir clairement le workspace ou la vue detaillee correspondante.

**Acceptance Scenarios**:

1. **Given** un job apparait dans le tableau de bord global, **When** l'utilisateur selectionne ce job, **Then** il peut acceder clairement a son workspace d'origine ou a sa vue detaillee existante.
2. **Given** plusieurs jobs proviennent du meme workspace, **When** l'utilisateur consulte la vue globale, **Then** chaque job reste rattache a son workspace d'origine sans ambiguite.
3. **Given** un job apparait dans la vue globale, **When** l'utilisateur lance une action disponible depuis cette vue, **Then** l'action s'applique au bon job sans exiger une ouverture prealable du workspace.

### Edge Cases

- Si un workspace reference par des donnees historiques n'est plus disponible ou a ete deplace, les jobs deja connus restent visibles avec un statut explicite signalant un workspace indisponible ou partiel.
- Comment la vue globale se comporte-t-elle lorsqu'aucun workspace ne contient de jobs ?
- Comment la vue globale gere-t-elle un volume important de jobs sans masquer les jobs critiques ?
- Que voit l'utilisateur si certaines donnees de workspace sont corrompues ou incompletes, mais que les autres restent lisibles ?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Le systeme MUST fournir une vue globale agregant les jobs de tous les workspaces connus par le plugin local.
- **FR-001a**: Cette vue globale MUST etre exposee comme un onglet global dedie, distinct des vues existantes par workspace.
- **FR-002**: La vue globale MUST afficher pour chaque job au minimum son nom, son workspace d'origine, son statut le plus recent, sa prochaine execution planifiee si elle existe, et un resume de recurrence lisible.
- **FR-003**: Les utilisateurs MUST pouvoir distinguer rapidement les jobs sains des jobs qui demandent une action, notamment les jobs en echec, rates, pauses ou sans prochaine execution exploitable.
- **FR-004**: Le systeme MUST permettre de filtrer la vue globale par statut de job au minimum.
- **FR-005**: Le systeme MUST permettre de trier ou organiser la vue globale de facon a faire ressortir les jobs les plus urgents ou les plus proches de leur prochaine execution.
- **FR-006**: Le systeme MUST afficher un resume global comprenant au minimum le nombre total de jobs et le nombre de jobs problematiques.
- **FR-007**: Le systeme MUST definir clairement l'etat a utiliser lorsqu'un job n'a jamais encore ete execute, afin que cet etat ne soit pas confondu avec un echec ou un job sain.
- **FR-008**: Le systeme MUST permettre a l'utilisateur d'acceder clairement depuis un job global a son contexte de workspace ou a sa vue detaillee existante.
- **FR-008a**: Le systeme MUST permettre a l'utilisateur d'executer depuis la vue globale des actions directes sur un job, sans devoir ouvrir d'abord son workspace d'origine.
- **FR-008b**: Les actions directes autorisees depuis la vue globale MUST etre limitees a `Run Now`, `Pause`, `Resume` et `Retry` pour la V0.2.0.
- **FR-009**: Le systeme MUST continuer a afficher les jobs lisibles meme si un ou plusieurs workspaces ne peuvent pas etre charges completement, et signaler les donnees partielles a l'utilisateur.
- **FR-009a**: Lorsqu'un workspace n'est plus lisible ou a ete deplace, les jobs deja connus pour ce workspace MUST rester visibles dans la vue globale avec un statut explicite indiquant un workspace indisponible ou partiel.
- **FR-010**: User-facing behavior MUST preserve loading, empty, success, error, and recovery states that are consistent with existing CloudCLI conventions.
- **FR-011**: User-facing behavior MUST define measurable response-time or refresh-time budgets for the global dashboard when aggregating all known jobs.
- **FR-011a**: Le tableau de bord global MUST se rafraichir automatiquement de facon periodique et MUST offrir un declenchement manuel explicite du rafraichissement.

### Key Entities *(include if feature involves data)*

- **Global Job Record**: Representation consolidee d'un job dans la vue globale, incluant son identite, son workspace d'origine, son etat recent, sa recurrence et sa prochaine execution.
- **Workspace Summary**: Resume d'un workspace dans le tableau de bord global, incluant le nombre de jobs qu'il contient et la presence eventuelle de jobs problematiques.
- **Workspace Availability State**: Etat de disponibilite d'un workspace dans la vue globale, indiquant s'il est lisible, partiellement lisible ou indisponible.
- **Global Dashboard Summary**: Vue agregée du parc complet de jobs, incluant les compteurs globaux, les regroupements de statut et les signaux d'alerte principaux.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un utilisateur peut identifier, depuis une seule vue, tous les jobs en echec, rates ou pauses parmi 100 jobs repartis sur plusieurs workspaces en moins de 30 secondes.
- **SC-002**: Le tableau de bord global charge et affiche un inventaire de 100 jobs agreges en moins de 2 secondes dans des conditions normales d'utilisation locale.
- **SC-003**: Au moins 90% des utilisateurs de test retrouvent le workspace d'origine d'un job cible depuis la vue globale en moins de 2 interactions.
- **SC-004**: Le tableau de bord global permet de reduire a une seule navigation initiale la consultation du statut global des jobs, au lieu d'une ouverture workspace par workspace.
- **SC-005**: Lorsqu'un ou plusieurs workspaces ne peuvent pas etre lus, 100% des autres jobs lisibles restent visibles et l'utilisateur est explicitement informe qu'il consulte une vue partielle.
- **SC-006**: Lorsqu'une execution ou un changement d'etat survient sur un job, l'information apparait dans le tableau de bord global en moins de 60 secondes sans action manuelle obligatoire.

## Assumptions

- La V0.2.0 introduit des actions directes job par job depuis la vue globale, mais pas encore d'operations de masse cross-workspace ni de modifications structurelles comme l'edition ou la suppression depuis cette vue.
- Les workspaces a agreger sont ceux deja connus du plugin via les donnees locales qu'il persiste.
- Les actions detaillees sur un job sont disponibles a la fois depuis la vue globale et depuis la vue workspace existante.
- Les definitions de statut deja etablies en V0.1.0 restent la base de reference fonctionnelle pour la vue globale.
- Le rafraichissement automatique periodique est suffisant pour la V0.2.0 et n'impose pas un mecanisme quasi temps reel.
