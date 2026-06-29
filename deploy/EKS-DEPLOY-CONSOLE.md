# Deploy to AWS EKS — Console walkthrough

Deploys `deploy/k8s/video-call.yaml` (images already on Docker Hub:
`993748048099/mediasoup:0.1.0` and `993748048099/mediasoup-frontend:0.1.0`).

> 💸 **Cost:** the EKS control plane is ~$0.10/hr (~$73/mo) **plus** EC2 nodes and
> data transfer. Delete everything (Phase 9) when you're done testing.

> ⚠️ **Three gotchas for this app, handled below:**
> 1. **EBS CSI driver** add-on — without it the MongoDB PVC never binds (Phase 2/3).
> 2. **Node public IP + announced IP** — browsers connect *directly* to the node
>    for WebRTC media, and `status.hostIP` is the node's *private* IP, so internet
>    clients need the public IP set explicitly (Phase 7).
> 3. **Security-group UDP ports** — media is UDP and must be opened manually (Phase 5).

---

## Phase 1 — IAM roles (one-time)

**Cluster role** (IAM → Roles → Create role):
- Trusted entity: **AWS service → EKS → EKS - Cluster**
- Policy `AmazonEKSClusterPolicy` is attached automatically → name it `eksClusterRole`.

**Node role** (IAM → Roles → Create role):
- Trusted entity: **AWS service → EC2**
- Attach: `AmazonEKSWorkerNodePolicy`, `AmazonEC2ContainerRegistryReadOnly`,
  `AmazonEKS_CNI_Policy` → name it `eksNodeRole`.

---

## Phase 2 — Create the cluster

EKS console → **Add cluster → Create**:
- **Name:** `video-call`, **Kubernetes version:** latest.
- **Cluster service role:** `eksClusterRole`.
- **Networking:** pick a VPC and **public subnets** (nodes need public IPs so
  browsers can reach the SFU). **Cluster endpoint access: Public**.
- **Add-ons:** keep CoreDNS / kube-proxy / Amazon VPC CNI, **and add “Amazon EBS
  CSI Driver”** (needed for the MongoDB volume).
- Create → wait ~10–15 min until status is **Active**.

---

## Phase 3 — EBS CSI driver permissions

The EBS CSI add-on needs an IAM role so it can create EBS volumes:
- EKS cluster → **Add-ons → Amazon EBS CSI Driver** (add it here if you skipped
  it in Phase 2).
- When prompted, create/attach a role with the **`AmazonEBSCSIDriverPolicy`**
  (the console offers “Create recommended role” via IRSA / Pod Identity).
- Without this the `mongo-data` PVC stays **Pending** and the mongo pod won't start.

---

## Phase 4 — Add a node group

EKS cluster → **Compute → Add node group**:
- **Name:** `ng-1`, **Node IAM role:** `eksNodeRole`.
- **Instance type:** start with `c5.large` (SFU is CPU-bound), **disk** 20–30 GiB.
- **Scaling:** min 1 / desired 1 / max 3.
- **Subnets:** choose the **public** subnets.
- Create → wait until the node is **Ready**.
- Confirm the node got a **public IP** (EC2 → Instances → your node → *Public IPv4
  address*). If blank, the subnet isn't auto-assigning public IPs — fix the
  subnet's “Auto-assign public IPv4” setting or attach an Elastic IP.

---

## Phase 5 — Open the security-group ports

EC2 → Instances → your node → **Security** tab → click the node security group →
**Inbound rules → Edit → Add rule** (Source `0.0.0.0/0`, or your client CIDR):

| Type        | Protocol | Port range  | Purpose                         |
|-------------|----------|-------------|---------------------------------|
| Custom TCP  | TCP      | 4000        | signaling / WebSocket           |
| Custom TCP  | TCP      | 30300       | web app (NodePort)              |
| Custom UDP  | UDP      | 40000-40100 | WebRTC media (RTP/SRTP)         |

---

## Phase 6 — Connect kubectl (AWS CloudShell)

Open **CloudShell** (top nav). It has the AWS CLI; install kubectl if needed.
```bash
aws eks update-kubeconfig --region <REGION> --name video-call
kubectl get nodes        # node should be Ready
```
> If you get “Unauthorized”: EKS cluster → **Access → Create access entry** for
> your IAM user/role and attach **AmazonEKSClusterAdminPolicy** (the cluster
> creator gets this automatically; a different identity needs it added).

---

## Phase 7 — Configure and deploy the manifest

1. Get the node's **public IP** (Phase 4).
2. Get the manifest into CloudShell — either **Actions → Upload file**
   (`video-call.yaml`), or `git clone` your repo.
3. **Edit two values** in `video-call.yaml`:
   - In the **ConfigMap**, set `SERVER_URL: "http://<NODE_PUBLIC_IP>:4000"`.
   - In the **server Deployment**, the announced IP defaults to `status.hostIP`
     (the node's *private* IP). For **internet clients**, replace that env block
     with the public IP so media is reachable:
     ```yaml
     env:
       - name: MEDIASOUP_ANNOUNCED_IP
         value: "<NODE_PUBLIC_IP>"
     ```
     (If your clients are inside the VPC/VPN, leave the `status.hostIP` version.)
4. Apply and watch:
```bash
kubectl apply -f video-call.yaml
kubectl -n video-call get pods -w     # wait for all Running
kubectl -n video-call get pvc         # mongo-data should be Bound
```

---

## Phase 8 — Use it

- **Web app:** `http://<NODE_PUBLIC_IP>:30300`
- Join a room; media flows to `<NODE_PUBLIC_IP>:4000` + UDP `40000-40100`.
- Logs: `kubectl -n video-call logs deploy/server`

---

## Scaling to multiple nodes (later)

`status.hostIP` / a single hardcoded public IP only works for one node. For a
multi-node SFU, each node has a different public IP, so use an **init container**
that reads the node's public IP from EC2 IMDS
(`http://169.254.169.254/latest/meta-data/public-ipv4`) and writes it to
`MEDIASOUP_ANNOUNCED_IP`, and convert the `server` Deployment to a **DaemonSet**
(one SFU per node). Ask and I'll add this to the manifest.

---

## Phase 9 — Tear down (avoid charges)

EKS cluster → **Compute** → delete the node group → wait → then delete the
cluster. Also remove any Elastic IPs / EBS volumes left behind.

---

## Faster alternative (CLI, not console)

`deploy/eksctl/cluster.yaml` does Phases 1–5 in one command:
```bash
eksctl create cluster -f deploy/eksctl/cluster.yaml
kubectl apply -f deploy/k8s/video-call.yaml
```
