variable "kubeconfig" {
  type    = string
  default = "~/.kube/config"
}

variable "context" {
  description = "10-cluster 의 output context (kind-study-tf)"
  type        = string
  default     = "kind-study-tf"
}

variable "namespace" {
  type    = string
  default = "study-tf"
}

variable "redis_image" {
  type    = string
  default = "redis:8-alpine"
}

variable "redis_maxmemory" {
  description = "Redis maxmemory (ConfigMap → redis.conf)"
  type        = string
  default     = "64mb"
}
