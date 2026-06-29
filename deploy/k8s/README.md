# Kubernetes deployment (plain manifests)

A single self-contained manifest — Redis, Kafka, MongoDB, the combined
signaling/SFU server, and the web app:

```bash
kubectl apply -f deploy/k8s/video-call.yaml
kubectl -n video-call get pods
```

## Build the images first

The cluster needs the two app images. Build them and make them available to your
nodes (push to a registry, or load into a local cluster):

```bash
# Server (combined signaling + SFU)
docker build -t video-call/server:0.1.0 apps/server

# Web — portable image, no build args. The backend URL is injected at runtime
# via the SERVER_URL env var (set in the ConfigMap), served to the browser at
# /api/config.
docker build -t video-call/web:0.1.0 apps/web

# Local clusters: load the images so IfNotPresent finds them
kind load docker-image video-call/server:0.1.0 video-call/web:0.1.0     # kind
# minikube image load video-call/server:0.1.0 video-call/web:0.1.0      # minikube
```

Set the backend URL the browser should use in the ConfigMap's `SERVER_URL`
(replace `REPLACE_WITH_NODE_IP`) — e.g. the node's external IP or `$(minikube ip)`.
Because it's runtime config, changing it is just a ConfigMap edit + pod restart,
no rebuild.

## How to reach it

- **Web app:** `http://<NODE_IP>:30300` (NodePort).
- **Signaling + media:** the `server` pod runs on **hostNetwork**, so it binds the
  node directly — HTTP/WS on `:4000` and WebRTC media on UDP `40000-40100`.
  Browsers connect straight to `<NODE_IP>:4000` (which is why the web image bakes
  that URL). Open those ports in any node firewall / security group.

## Why hostNetwork for the server

WebRTC media is RTP/SRTP over UDP and can't go through an HTTP ingress or L7 load
balancer. The server pod therefore uses `hostNetwork: true` and announces the
node's IP to mediasoup (via the downward API `status.hostIP`), so media flows
directly to the node. `dnsPolicy: ClusterFirstWithHostNet` keeps in-cluster DNS
working so it can still reach the `redis` / `kafka` / `mongo` Services.

## Notes

- **Scaling the server:** with hostNetwork only one server pod fits per node.
  Raise `replicas` *and* add node anti-affinity, or convert the `server`
  Deployment to a DaemonSet (one per node) and add nodes.
- **Cloud public IP:** `status.hostIP` is the node's primary IP. On clouds where
  that is private, set `MEDIASOUP_ANNOUNCED_IP` explicitly to the public IP
  instead of the downward-API value.
- **Don't need Kafka?** Set `ENABLE_KAFKA: "false"` in the ConfigMap and delete the
  `kafka` Deployment/Service. Same pattern for Redis/Mongo.
- **Storage:** the Mongo PVC uses the cluster's default StorageClass. If your
  cluster has none, add `storageClassName:` to the PVC.
```bash
kubectl delete -f deploy/k8s/video-call.yaml   # tear everything down
```
