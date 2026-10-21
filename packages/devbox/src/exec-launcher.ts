/**
 * How a command string runs on the box: it answers when the command itself exits.
 *
 * The platform's exec answers when its output pipes close (D64), and a process the command starts in the background
 * (`setsid -f chromium …`, `server &`) inherits them. So an exec waited on whatever the command left running, for as
 * long as it ran: the owner's `setsid -f chromium https://www.youtube.com` opened the browser at once and its call
 * never answered (2026-10-20). Here the command writes to pipes a drainer holds. The drainer forwards what it reads to
 * the platform's pipes until the command exits, then closes them so the exec answers, and goes on reading and
 * discarding until the last writer closes. What the command left running keeps an open reader, so it never meets a
 * closed pipe, and its later output takes no disk.
 *
 * Perl because it is the one interpreter the box always has (Debian's perl-base is Essential), and the drainer needs
 * to wait on three pipes at once, which bash cannot. Its exit status is the command's, a signal death `128 + n`.
 */
const LAUNCHER = String.raw`use strict;
use warnings;
use POSIX ();

pipe(my $out_r, my $out_w) or die "kinu exec: pipe: $!\n";
pipe(my $err_r, my $err_w) or die "kinu exec: pipe: $!\n";
# Held by this process alone: its exit is how the drainer learns the command has exited.
pipe(my $end_r, my $end_w) or die "kinu exec: pipe: $!\n";

my $drainer = fork() // die "kinu exec: fork: $!\n";

if ($drainer == 0) {
  close $_ for $out_w, $err_w, $end_w;
  $SIG{PIPE} = 'IGNORE';
  my %open = (fileno($out_r) => [$out_r, \*STDOUT], fileno($err_r) => [$err_r, \*STDERR]);
  my $forwarding = 1;
  my $buffer;
  # One read of $fd, forwarded while forwarding; answers the bytes read, 0 at its end.
  my $pass = sub {
    my ($fd) = @_;
    my ($from, $to) = @{ $open{$fd} };
    my $read = sysread($from, $buffer, 65536);

    return 0 if !defined $read && $!{EINTR};

    if (!$read) {
      delete $open{$fd};

      return 0;
    }

    my $at = 0;

    while ($forwarding && $at < $read) {
      my $wrote = syswrite($to, $buffer, $read - $at, $at);

      if (defined $wrote) { $at += $wrote; next; }
      next if $!{EINTR};
      # The exec's reader is gone: discard from here.
      $forwarding = 0;
    }

    return $read;
  };
  my $ready = sub {
    my ($wait, @fds) = @_;
    my $in = '';
    vec($in, $_, 1) = 1 for @fds;
    my $count = select(my $out = $in, undef, undef, $wait);

    return $count > 0 ? grep { vec($out, $_, 1) } @fds : ();
  };
  my $end = fileno($end_r);

  while (%open) {
    my @fds = $ready->(undef, keys %open, $forwarding ? ($end) : ());

    if (grep { $_ == $end } @fds) {
      # The command has exited, so all it wrote is in the pipes: forward that (bounded: what it left running may write
      # without end), then let the exec answer.
      my $budget = 1 << 20;

      while ($budget > 0 && %open) {
        my @waiting = $ready->(0, keys %open) or last;
        $budget -= $pass->($_) for @waiting;
      }

      close STDOUT;
      close STDERR;
      $forwarding = 0;
      next;
    }

    $pass->($_) for grep { $_ != $end } @fds;
  }

  POSIX::_exit(0);
}

my $command = fork() // die "kinu exec: fork: $!\n";

if ($command == 0) {
  close $_ for $out_r, $err_r, $end_r, $end_w;
  open(STDIN, '<', '/dev/null');
  open(STDOUT, '>&', $out_w);
  open(STDERR, '>&', $err_w);
  close $_ for $out_w, $err_w;
  exec('/bin/bash', '-c', $ARGV[0]) or POSIX::_exit(127);
}

close $_ for $out_r, $err_r, $end_r, $out_w, $err_w;
close STDOUT;
close STDERR;
waitpid($command, 0);
my $status = $?;
exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
`;

/** The argv a command string runs as. */
export function launched(command: string): readonly string[] {
  return ['/usr/bin/perl', '-e', LAUNCHER, '--', command];
}
