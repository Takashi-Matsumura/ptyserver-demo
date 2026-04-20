FROM ubuntu:24.04

# apt 実行中に tzdata などが対話を要求するのを防ぐ
ENV DEBIAN_FRONTEND=noninteractive

# 学習サンドボックスの常用ツールを一式 prebuild しておく。
# ここに入れておくと「セッション破棄」で /root 以外が初期化されても
# 次回接続時には即座に使える状態で立ち上がる。
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      less \
      nano \
      procps \
      vim && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /root

# CMD は docker-session 側で ["sleep", "infinity"] を上書き指定しているので
# ここでは定義しない。TERM 等の Env も呼び出し側で渡す。
