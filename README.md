# Uber ride-booking demo

Plain Node.js microservices with a small browser UI. Each app service is self-contained in its own folder, with its own `package.json`, runtime helpers, and two-stage Dockerfile.

## Requirements

- Node.js 20+
- PostgreSQL
- RabbitMQ

Create a PostgreSQL role/database and a RabbitMQ user, then copy `.env.example` to `.env` and set matching credentials plus a distinct random `JWT_SECRET`. For hex credentials, generate values with `openssl rand -hex 32`. The services create their own schemas on startup. They build local connection URLs from these settings; optionally set `DATABASE_URL` or `AMQP_URL` to connect to non-local hosts.

Each service reads its credentials and `PORT` from its environment. Install dependencies independently:

```sh
npm install --prefix services/iam
npm install --prefix services/user
npm install --prefix services/route
npm install --prefix services/rider
npm install --prefix services/payment
```

Run each command in a separate terminal from the repository root:

```sh
set -a; . ./.env; set +a; PORT=3001 npm --prefix services/iam start
set -a; . ./.env; set +a; PORT=3002 npm --prefix services/user start
set -a; . ./.env; set +a; PORT=3003 npm --prefix services/route start
set -a; . ./.env; set +a; PORT=3004 npm --prefix services/rider start
set -a; . ./.env; set +a; PORT=3005 npm --prefix services/payment start
```

Check service health at `/health` on ports `3001`–`3005`. Open `ui/index.html` in a browser to try signup, login, requesting rides, and rider actions. Run the end-to-end checks with `node tests/e2e.js` while the five services and their PostgreSQL/RabbitMQ dependencies are running.

## Service folders

- `services/iam` — signup, login, and JWTs
- `services/user` — passenger ride API
- `services/route` — rider matching and dispatch
- `services/rider` — rider availability and trip actions
- `services/payment` — event-based fare calculation

Each folder can be installed and run independently. Shared runtime helpers are kept inside each service folder so its source does not depend on files outside that folder.

## Build images

Build each app image from its service folder so the independent build context contains all of that service's code:

```sh
docker build -t uber-iam:local services/iam
docker build -t uber-user:local services/user
docker build -t uber-route:local services/route
docker build -t uber-rider:local services/rider
docker build -t uber-payment:local services/payment
docker build -t uber-ui:local ui
```

PostgreSQL and RabbitMQ have separate Dockerfiles under `infrastructure/`. These customize the official images; they do not bundle application data or credentials:

```sh
docker build -t uber-postgres:local infrastructure/postgres
docker build -t uber-rabbitmq:local infrastructure/rabbitmq
```

Pass database/broker credentials and service connection settings at container runtime. Keep persistent database and RabbitMQ data in runtime-managed volumes, not in these images.

Keep the five application Dockerfiles with their service code in the application repo. The PostgreSQL and RabbitMQ Dockerfiles here only add their config files; Kubernetes/Helm manifests can live in a separate GitOps repo.

## Deploy to the kind cluster with Helm and Ingress

The chart in `helm/uber` creates ClusterIP Services and Deployments for the five APIs, a UI Deployment, StatefulSets with persistent volumes for PostgreSQL and RabbitMQ, and an Ingress for the UI plus IAM, User, and Rider APIs. It schedules the database and broker to the matching worker labels in `kind-config.yaml`; the API and UI pods are spread across the two `workload=app` workers. The ingress-nginx controller is installed separately using the kind-specific values in `helm/ingress-nginx/values-kind.yaml`.

The kind config maps localhost ports 80/443 to the control-plane node, where ingress-nginx runs. These port mappings are fixed when the cluster is created. If your existing `uber-platform` cluster was created before this config, recreate it to enable ingress host-port access; doing so deletes its in-cluster data unless you back it up first.

Install the ingress controller:

```sh
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  -f helm/ingress-nginx/values-kind.yaml
```

Build and load the local images into the cluster:

```sh
docker build -t uber-iam:latest services/iam
docker build -t uber-user:latest services/user
docker build -t uber-route:latest services/route
docker build -t uber-rider:latest services/rider
docker build -t uber-payment:latest services/payment
docker build -t uber-ui:latest ui
docker build -t uber-postgres:latest infrastructure/postgres
docker build -t uber-rabbitmq:latest infrastructure/rabbitmq
kind load docker-image uber-iam:latest uber-user:latest uber-route:latest \
  uber-rider:latest uber-payment:latest uber-postgres:latest uber-rabbitmq:latest \
  uber-ui:latest \
  --name uber-platform
```

Create the Kubernetes Secret from your local `.env` before installing the chart. The file should contain the six keys in `.env.example`; use URL-safe hex characters for passwords because the services use them in connection URLs.

```sh
kubectl create namespace uber --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic uber-secrets -n uber --from-env-file=.env \
  --dry-run=client -o yaml | kubectl apply -f -
helm lint helm/uber
helm upgrade --install uber helm/uber --namespace uber
kubectl get pods -n uber -o wide
```

Add `uber.local` to your machine's hosts file pointing to `127.0.0.1`, then browse `http://uber.local`. Ingress serves the UI at `/` and forwards `/api/iam`, `/api/user`, and `/api/rider` to their corresponding services. Opening `ui/index.html` directly from disk uses localhost service ports, so use the port-forwards below in that case:

```sh
kubectl port-forward -n uber svc/iam 3001:3000
kubectl port-forward -n uber svc/user 3002:3000
kubectl port-forward -n uber svc/rider 3004:3000
```

PostgreSQL and RabbitMQ are single instances here; the persistent volumes do not replace backups or provide high availability.